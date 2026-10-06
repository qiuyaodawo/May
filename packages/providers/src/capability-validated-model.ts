import { ModelProtocolError, ModelResponseValidationError, assertModelResponseFormat, type Model, type ModelContextCompactor, type ModelLimits, type ModelEvent, type ModelRequest, type ModelResponseFormat, type ModelStreamOptions } from "@may/core";
import { createModelCapabilityResolver, type ModelCapabilities, type ModelCapabilityResolver } from "./capabilities.js";
import { ModelRequestValidationError, validateModelRequest, validateStructuredModelResponse, type ModelRequestValidationOptions, type ModelRequestValidationResult } from "./validation.js";
import type { ProviderModelSelection } from "./types.js";

export interface CapabilityValidatedModelOptions extends ModelRequestValidationOptions {
  readonly resolver?: ModelCapabilityResolver;
}
export class CapabilityValidatedModel implements Model {
  readonly contextCompactor?: ModelContextCompactor;
  private readonly resolver: ModelCapabilityResolver;
  private capabilities: ModelCapabilities | undefined;
  private validation: ModelRequestValidationResult | undefined;
  private readonly selection: ProviderModelSelection;
  private readonly responseFormat: ModelResponseFormat | undefined;
  private readonly unknownPolicy: NonNullable<ModelRequestValidationOptions["unknownPolicy"]>;
  constructor(private readonly model: Model, selection: ProviderModelSelection, private readonly options: CapabilityValidatedModelOptions = {}) {
    this.resolver = options.resolver ?? createModelCapabilityResolver();
    this.selection = structuredClone(selection);
    const responseFormat = selection.options.responseFormat;
    if (responseFormat !== undefined) {
      if (typeof responseFormat !== "object" || responseFormat === null || !("type" in responseFormat) || (responseFormat.type !== "json" && responseFormat.type !== "jsonSchema")) {
        throw new TypeError("options.responseFormat must be a JSON or JSON Schema response format");
      }
      this.responseFormat = structuredClone(responseFormat) as ModelResponseFormat;
      assertModelResponseFormat({ messages: [], tools: [], responseFormat: this.responseFormat });
    }
    const unknownPolicy = options.unknownPolicy ?? selection.options.unknownCapabilityPolicy ?? "allow";
    if (unknownPolicy !== "allow" && unknownPolicy !== "require-known") throw new TypeError("unknownCapabilityPolicy must be allow or require-known");
    this.unknownPolicy = unknownPolicy;
    const compactor = model.contextCompactor;
    if (compactor !== undefined) this.contextCompactor = {
      name: compactor.name,
      compact: async (snapshot, compactOptions) => {
        compactOptions.signal?.throwIfAborted();
        const capabilities = await this.getModelCapabilities();
        compactOptions.signal?.throwIfAborted();
        const capability = capabilities.fields?.contextCompaction;
        if (capability?.status === "unsupported" || (this.unknownPolicy === "require-known" && capability?.status !== "known")) {
          this.validation = { status: "invalid", issues: [{ field: "contextCompactor", capability: "contextCompaction", code: capability?.status === "unsupported" ? "unsupported" : "unknown", message: "Native Context compaction capability is unavailable" }] };
          throw new ModelRequestValidationError(this.validation);
        }
        const request: ModelRequest = { messages: snapshot.instructions === undefined ? snapshot.messages : [{ role: "system", content: [{ type: "text", text: snapshot.instructions }] }, ...snapshot.messages], tools: [] };
        this.validate(request, capabilities, { ...this.options, unknownPolicy: this.unknownPolicy });
        if (capability?.status !== "known") this.validation = { status: "unknown", issues: [...this.validation!.issues, { field: "contextCompactor", capability: "contextCompaction", code: "unknown", message: "Native Context compaction capability is unknown" }] };
        let success = false;
        try {
          const result = await compactor.compact(snapshot, compactOptions);
          success = true;
          return result;
        } finally { this.resolver.recordVerification(this.selection, request, success, false, ["contextCompaction"]); }
      },
    };
  }
  get limits(): ModelLimits | undefined {
    const limits: { contextWindowTokens?: number; maxOutputTokens?: number } = {};
    for (const key of ["contextWindowTokens", "maxOutputTokens"] as const) {
      const declarations = [this.model.limits?.[key], this.selection.capabilities?.fields?.[key], this.selection.providerConfig.capabilities?.fields?.[key]];
      const resolved = [this.capabilities?.fields?.[key], ...Object.values(this.capabilities?.layers ?? {}).map((layer) => layer[key])]
        .flatMap((capability) => capability?.status === "known" && typeof capability.value === "number" ? [capability.value] : []);
      const values = [...declarations, ...resolved].filter((value): value is number => typeof value === "number");
      if (values.length > 0) limits[key] = Math.min(...values);
    }
    return Object.keys(limits).length === 0 ? undefined : limits;
  }
  get reportsAttempts() { return this.model.reportsAttempts; }
  get capabilityVersion() { return this.capabilities?.version; }
  get configuration(): Readonly<Record<string, string | number | boolean>> {
    return { provider: this.selection.provider, adapter: this.selection.adapter, model: this.selection.model, profile: this.selection.profile, ...(typeof this.selection.options.reasoningEffort === "string" ? { reasoningEffort: this.selection.options.reasoningEffort } : {}), ...(this.capabilityVersion === undefined ? {} : { capabilityVersion: this.capabilityVersion }) };
  }
  get lastValidation() { return this.validation; }
  async getModelCapabilities(): Promise<ModelCapabilities> {
    this.capabilities = await this.resolver.resolve(this.selection);
    return this.capabilities;
  }
  async refreshCapabilities(): Promise<ModelCapabilities> {
    this.capabilities = await this.resolver.resolve(this.selection, { refresh: true });
    return this.capabilities;
  }
  async preflight(request: ModelRequest, options: ModelStreamOptions): Promise<void> {
    request = this.effectiveRequest(request);
    options.signal.throwIfAborted();
    const capabilities = await this.getModelCapabilities();
    options.signal.throwIfAborted();
    const { responseFormat: configuredFormat, unknownCapabilityPolicy: configuredPolicy, ...configuredParameters } = this.selection.options;
    const parameters: Record<string, unknown> = configuredParameters;
    if (parameters.maxTokens === undefined && parameters.maxOutputTokens === undefined && this.selection.limits?.maxOutputTokens !== undefined) {
      const key = ["deepseek-chat", "kimi-chat", "zhipu-chat", "anthropic-messages"].includes(this.selection.adapter) ? "maxTokens" : "maxOutputTokens";
      parameters[key] = this.selection.limits.maxOutputTokens;
    }
    this.validate(request, capabilities, { ...this.options, unknownPolicy: this.unknownPolicy, parameters: this.options.parameters ?? parameters });
  }
  async *stream(request: ModelRequest, options: ModelStreamOptions): AsyncIterable<ModelEvent> {
    request = this.effectiveRequest(request);
    await this.preflight(request, options);
    const capabilities = this.capabilities!;
    let completed = false;
    let verified = false;
    let responseValidated = false;
    try {
      for await (const event of this.model.stream(request, options)) {
        if (event.type === "response.completed") {
          if (completed) throw new ModelProtocolError("Model emitted more than one response.completed event");
          completed = true;
          validateStructuredModelResponse(event.message, request, event);
          responseValidated = request.responseFormat !== undefined && (event.message.toolCalls?.length ?? 0) === 0;
          const limits = [capabilities.fields?.["tools.maxCalls"], ...Object.values(capabilities.layers ?? {}).map((layer) => layer["tools.maxCalls"])]
            .flatMap((limit) => limit?.status === "known" && typeof limit.value === "number" ? [limit.value] : []);
          if ((event.message.toolCalls?.length ?? 0) > 0 && capabilities.fields?.["tools.maxCalls"]?.status === "unsupported") throw new ModelResponseValidationError("Model response uses unsupported tools.maxCalls", event);
          if (limits.length > 0 && (event.message.toolCalls?.length ?? 0) > Math.min(...limits)) {
            throw new ModelResponseValidationError("Model response exceeds tools.maxCalls", event);
          }
        }
        yield event;
      }
      if (!completed) throw new ModelProtocolError("Model stream ended without a response.completed event");
      verified = true;
    } finally { this.resolver.recordVerification(this.selection, request, verified, responseValidated); }
  }
  private validate(request: ModelRequest, capabilities: ModelCapabilities, options: ModelRequestValidationOptions): void {
    this.validation = validateModelRequest(request, capabilities, options);
    if (this.validation.status === "invalid") throw new ModelRequestValidationError(this.validation);
  }
  private effectiveRequest(request: ModelRequest): ModelRequest {
    return request.responseFormat === undefined && this.responseFormat !== undefined ? { ...request, responseFormat: this.responseFormat } : request;
  }
}
export function createCapabilityValidatedModel(model: Model, selection: ProviderModelSelection, options: CapabilityValidatedModelOptions = {}): CapabilityValidatedModel {
  return new CapabilityValidatedModel(model, selection, options);
}
