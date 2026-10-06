import { assertModelResponseFormat, compileModelSchema, modelSchemaDialect, type ContentPart, type JsonSchema, type ModelRequest } from "@may/core";
export { validateStructuredModelResponse } from "@may/core";
import type { CapabilityValue, ModelCapabilities, ModelCapabilityKey } from "./capabilities.js";

export type UnknownCapabilityPolicy = "allow" | "require-known";
export interface ModelRequestValidationIssue {
  readonly field: string;
  readonly capability: ModelCapabilityKey | "reasoningEffort";
  readonly code: "unsupported" | "unknown" | "limit" | "parameter" | "schema";
  readonly message: string;
}
export interface ModelRequestValidationResult {
  readonly status: "valid" | "unknown" | "invalid";
  readonly issues: readonly ModelRequestValidationIssue[];
}
export interface ModelRequestValidationOptions {
  readonly unknownPolicy?: UnknownCapabilityPolicy;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly estimatedInputTokens?: number;
  readonly mediaMetadata?: (part: ContentPart, field: string) => { readonly bytes?: number; readonly mediaType?: string } | undefined;
}
export class ModelRequestValidationError extends TypeError {
  readonly code = "MODEL_REQUEST_VALIDATION_FAILED";
  constructor(readonly result: ModelRequestValidationResult) {
    super(result.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "));
    this.name = "ModelRequestValidationError";
  }
}

export function validateModelRequest(request: ModelRequest, capabilities: ModelCapabilities, options: ModelRequestValidationOptions = {}): ModelRequestValidationResult {
  assertModelResponseFormat(request);
  if (options.unknownPolicy !== undefined && options.unknownPolicy !== "allow" && options.unknownPolicy !== "require-known") throw new TypeError("unknownPolicy must be allow or require-known");
  const issues: ModelRequestValidationIssue[] = [];
  const report = (field: string, capability: ModelRequestValidationIssue["capability"], code: ModelRequestValidationIssue["code"], message: string) => issues.push({ field, capability, code, message });
  const values = (key: ModelCapabilityKey): readonly CapabilityValue[] => [capabilities.fields?.[key], ...Object.values(capabilities.layers ?? {}).map((layer) => layer[key])].filter((value): value is CapabilityValue => value !== undefined);
  const requireCapability = (key: ModelCapabilityKey, field: string) => {
    const candidates = values(key);
    if (candidates.some((value) => value.status === "unsupported")) report(field, key, "unsupported", `${key} is unsupported`);
    else if (capabilities.fields?.[key]?.status !== "known") report(field, key, "unknown", `${key} is unknown`);
  };
  const knownValues = (key: ModelCapabilityKey) => values(key).flatMap((value) => value.status === "known" ? [value.value] : []);
  const limit = (key: ModelCapabilityKey, amount: number, field: string) => {
    if (amount > 0 && values(key).some((value) => value.status === "unsupported")) report(field, key, "unsupported", `${key} is unsupported`);
    const limits = knownValues(key).filter((value): value is number => typeof value === "number");
    if (limits.length > 0 && amount > Math.min(...limits)) report(field, key, "limit", `${key} must not exceed ${Math.min(...limits)}`);
  };
  let images = 0;
  let attachments = 0;
  request.messages.forEach((message, messageIndex) => message.content.forEach((part, partIndex) => {
    const field = `messages.${messageIndex}.content.${partIndex}`;
    if (part.type === "reasoning") return;
    if (part.type === "text" || part.type === "json") { requireCapability("input.text", field); return; }
    if (part.type === "resource") { requireCapability("input.resource", field); return; }
    requireCapability(`input.${part.type}`, field);
    attachments += 1;
    if (part.type === "image") images += 1;
    const sourceKey = `input.${part.type}.sources` as ModelCapabilityKey;
    requireCapability(sourceKey, `${field}.source`);
    for (const allowed of knownValues(sourceKey)) {
      if (Array.isArray(allowed) && !allowed.includes(part.source.type)) report(`${field}.source.type`, sourceKey, "unsupported", `${part.source.type} source is unsupported`);
    }
    const supplied = options.mediaMetadata?.(part, field);
    const bytes = part.source.type === "base64" ? Buffer.byteLength(part.source.data, "base64") : supplied?.bytes;
    const mediaType = part.source.type === "base64" ? part.source.mediaType : supplied?.mediaType;
    if (bytes !== undefined) {
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new TypeError(`${field} media bytes must be a non-negative safe integer`);
      limit("maxAttachmentBytes", bytes, field);
    } else if (knownValues("maxAttachmentBytes").length > 0) report(field, "maxAttachmentBytes", "unknown", "Attachment size is unknown");
    if (part.type === "file") {
      if (values("fileTypes").some((value) => value.status === "unsupported")) report(field, "fileTypes", "unsupported", "File media types are unsupported");
      for (const allowed of knownValues("fileTypes")) {
        if (!Array.isArray(allowed)) continue;
        if (mediaType === undefined) report(field, "fileTypes", "unknown", "File media type is unknown");
        else if (!allowed.includes(mediaType)) report(field, "fileTypes", "unsupported", "File media type is unsupported");
      }
    }
  }));
  limit("maxImages", images, "messages");
  limit("maxAttachments", attachments, "messages");
  if (request.tools.length > 0) requireCapability("tools", "tools");
  const parameters = options.parameters ?? {};
  if (Object.keys(parameters).length > 0) requireCapability("parameters", "parameters");
  const effort = parameters.reasoningEffort;
  const thinking = parameters.thinking;
  if (thinking !== undefined && thinking !== "disabled" && !(typeof thinking === "object" && thinking !== null && "type" in thinking && thinking.type === "disabled")) {
    const mode = typeof thinking === "object" && thinking !== null && "type" in thinking && thinking.type === "adaptive" ? "adaptive"
      : typeof thinking === "object" && thinking !== null && "budgetTokens" in thinking ? "budget" : "thinking";
    requireCapability("reasoning.modes", "parameters.thinking");
    for (const modes of knownValues("reasoning.modes")) if (Array.isArray(modes) && !modes.includes(mode)) report("parameters.thinking", "reasoning.modes", "unsupported", `${mode} reasoning mode is unsupported`);
  }
  if (parameters.reasoningSummary !== undefined) {
    requireCapability("reasoning.modes", "parameters.reasoningSummary");
    for (const modes of knownValues("reasoning.modes")) if (Array.isArray(modes) && !modes.includes("summary")) report("parameters.reasoningSummary", "reasoning.modes", "unsupported", "reasoning summary mode is unsupported");
  }
  if (effort !== undefined) {
    for (const modes of values("reasoning.modes")) {
      if (modes.status === "unsupported" || (modes.status === "known" && Array.isArray(modes.value) && !modes.value.includes("effort"))) report("parameters.reasoningEffort", "reasoning.modes", "unsupported", "effort reasoning mode is unsupported");
    }
    const reasoning = capabilities.reasoningEffort;
    if (reasoning.status === "unsupported") report("parameters.reasoningEffort", "reasoningEffort", "unsupported", "reasoning effort is unsupported");
    else if (reasoning.status === "unknown") report("parameters.reasoningEffort", "reasoningEffort", "unknown", "reasoning effort is unknown");
    else if (typeof effort !== "string" || !reasoning.efforts.includes(effort)) report("parameters.reasoningEffort", "reasoningEffort", "parameter", `reasoningEffort must be one of ${reasoning.efforts.join(", ")}`);
  }
  for (const key of ["maxTokens", "maxOutputTokens"] as const) if (parameters[key] !== undefined) {
    if (!Number.isSafeInteger(parameters[key]) || (parameters[key] as number) < 1) report(`parameters.${key}`, "maxOutputTokens", "parameter", "Output token limit must be a positive safe integer");
    else limit("maxOutputTokens", parameters[key] as number, `parameters.${key}`);
  }
  if (options.estimatedInputTokens !== undefined) {
    if (!Number.isSafeInteger(options.estimatedInputTokens) || options.estimatedInputTokens < 0) throw new TypeError("estimatedInputTokens must be a non-negative safe integer");
    const outputTokens = parameters.maxOutputTokens ?? parameters.maxTokens;
    const reservedOutput = typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : 0;
    limit("contextWindowTokens", options.estimatedInputTokens + reservedOutput, "messages");
    if (knownValues("contextWindowTokens").length > 0 && outputTokens === undefined) report("parameters", "maxOutputTokens", "unknown", "Requested output token reservation is unknown");
  } else if (knownValues("contextWindowTokens").length > 0) {
    report("messages", "contextWindowTokens", "unknown", "Input token estimate is unavailable");
  }
  for (const schema of knownValues("parameters")) {
    const validator = compileModelSchema(schema as JsonSchema);
    if (!validator(parameters)) report("parameters", "parameters", "parameter", "Parameters do not satisfy the declared constraints");
  }
  const format = request.responseFormat;
  if (format !== undefined) {
    const key = format.type === "json" ? "structuredOutput.json" : "structuredOutput.jsonSchema";
    requireCapability(key, "responseFormat");
    if (format.type === "jsonSchema") {
      if (typeof format.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(format.name)) report("responseFormat.name", key, "schema", "Schema name must contain 1 through 64 letters, digits, underscores, or hyphens");
      const dialect = modelSchemaDialect(format.schema);
      requireCapability("structuredOutput.schemaDialects", "responseFormat.schema");
      requireCapability("structuredOutput.schemaConstraint", "responseFormat.schema");
      for (const allowed of knownValues("structuredOutput.schemaDialects")) if (Array.isArray(allowed) && !allowed.includes(dialect)) report("responseFormat.schema", "structuredOutput.schemaDialects", "schema", "Schema dialect is unsupported");
      for (const constraint of knownValues("structuredOutput.schemaConstraint")) if (!compileModelSchema(constraint as JsonSchema)(format.schema)) report("responseFormat.schema", "structuredOutput.schemaConstraint", "schema", "Schema exceeds the declared supported scope");
      compileModelSchema(format.schema);
    }
  }
  const unique = issues.filter((issue, index) => issues.findIndex((other) => other.field === issue.field && other.capability === issue.capability && other.code === issue.code) === index);
  const invalid = unique.some((issue) => issue.code !== "unknown") || (options.unknownPolicy === "require-known" && unique.length > 0);
  return { status: invalid ? "invalid" : unique.length > 0 ? "unknown" : "valid", issues: unique };
}

export function assertModelRequestValid(request: ModelRequest, capabilities: ModelCapabilities, options: ModelRequestValidationOptions = {}): ModelRequestValidationResult {
  const result = validateModelRequest(request, capabilities, options);
  if (result.status === "invalid") throw new ModelRequestValidationError(result);
  return result;
}
