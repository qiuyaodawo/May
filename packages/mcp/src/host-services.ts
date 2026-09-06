import { realpath, stat } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { specTypeSchemas, type ClientCapabilities, type CreateMessageRequestParams, type CreateMessageResult, type CreateMessageResultWithTools, type Root } from "@modelcontextprotocol/client";
import { McpCapabilityError } from "./errors.js";
import type { McpInteractionBroker, McpInteractionOwner, McpHostReviewParams } from "./interactions.js";

/** Explicit compatibility switches. Disabled unless the host also supplies a UI and service. */
export interface McpServerHostOptions {
  readonly roots?: boolean;
  readonly sampling?: boolean;
  /** One fresh transport/process for each legacy interactive operation, never shared/reused. */
  readonly legacyRequests?: "isolated";
}

export interface McpHostRequestContext {
  readonly serverId: string;
  readonly requestId: string;
  readonly owner: McpInteractionOwner;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
}

export interface McpSamplingService {
  /** Tool proposals/results within the sampling exchange; never invokes host tools. */
  readonly supportsTools?: boolean;
  /** Must enforce maxTokens at the provider and honor signal; no implicit host Context. */
  createMessage(params: CreateMessageRequestParams, context: McpHostRequestContext): Promise<CreateMessageResult | CreateMessageResultWithTools>;
}

export interface McpHostServices {
  /** Host-selected allowlist only. The server cannot nominate directories. */
  readonly roots?: (context: McpHostRequestContext) => Promise<readonly Root[]>;
  readonly sampling?: McpSamplingService;
}

export interface McpInputBinding {
  readonly id: string;
  readonly owner: McpInteractionOwner | undefined;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly beforeRetry: () => Promise<void>;
  count: number;
  samplingCalls: number;
  samplingTokens: number;
  beforeSampling?: (maxTokens: number) => Promise<void>;
}

export function hostCapabilities(options: McpServerHostOptions | undefined, broker: McpInteractionBroker | undefined, services: McpHostServices | undefined): ClientCapabilities {
  if (broker === undefined) return {};
  return {
    elicitation: { form: {}, url: {} },
    ...(options?.roots && services?.roots ? { roots: {} } : {}),
    ...(options?.sampling && services?.sampling ? { sampling: services.sampling.supportsTools ? { tools: {} } : {} } : {}),
  };
}

/** Shared by modern MRTR and explicitly isolated legacy requests. No callback without consent. */
export class McpHostServiceRunner {
  constructor(private readonly serverId: string, private readonly broker: McpInteractionBroker, private readonly services: McpHostServices) {}

  async roots(binding: McpInputBinding, signal: AbortSignal): Promise<{ roots: Root[] }> {
    const context = this.context(binding, signal);
    await binding.beforeRetry();
    const candidates = await this.services.roots!(context);
    hostBounded(candidates, this.serverId);
    if (!Array.isArray(candidates) || candidates.length > 32) throw hostFailure(this.serverId, "root list exceeds host limits");
    const roots: Root[] = [];
    for (const root of candidates) {
      const url = new URL(root.uri);
      if (url.protocol !== "file:" || url.username || url.password || url.search || url.hash || url.hostname && url.hostname !== "localhost") throw hostFailure(this.serverId, "root must be a local file URI");
      const path = await realpath(fileURLToPath(url));
      const info = await stat(path);
      if (!info.isDirectory() && !info.isFile()) throw hostFailure(this.serverId, "root is not a regular file or directory");
      const uri = pathToFileURL(path).href;
      if (roots.some((entry) => entry.uri === uri)) continue;
      if (root.name !== undefined && (typeof root.name !== "string" || root.name.length > 256)) throw hostFailure(this.serverId, "invalid root name");
      roots.push({ uri, ...(root.name === undefined ? {} : { name: root.name }) });
    }
    const reviewed = await this.review(binding, signal, { mode: "review", kind: "roots", editable: false,
      message: "Share these host-selected root paths with this MCP server? Roots are guidance, NOT a filesystem sandbox or an access grant.", data: roots });
    if (reviewed === undefined) return { roots: [] };
    // Check accessibility again after human waiting, without silently changing a path.
    for (const root of roots) {
      const path = fileURLToPath(root.uri);
      if (pathToFileURL(await realpath(path)).href !== root.uri) throw hostFailure(this.serverId, "root changed during consent");
      await stat(path);
    }
    await binding.beforeRetry(); signal.throwIfAborted();
    return { roots };
  }

  async sample(binding: McpInputBinding, raw: CreateMessageRequestParams, signal: AbortSignal): Promise<CreateMessageResult | CreateMessageResultWithTools> {
    const context = this.context(binding, signal);
    if (++binding.samplingCalls > 4) throw hostFailure(this.serverId, "sampling exceeds four calls per flow");
    const initial = await this.samplingParams(raw);
    const input = await this.review(binding, signal, { mode: "review", kind: "sampling.request", editable: true,
      message: "Allow an isolated model request billed to the host? Only this reviewed input is sent. No Session history, other servers, or executable host tools are included. The host chooses the model; provider generation settings may override optional hints.", data: initial });
    if (input === undefined) throw hostFailure(this.serverId, "sampling request declined or cancelled");
    const params = await this.samplingParams(input);
    if (binding.samplingTokens + params.maxTokens > 16_384) throw hostFailure(this.serverId, "sampling flow token budget exceeded");
    binding.samplingTokens += params.maxTokens;
    await binding.beforeRetry(); signal.throwIfAborted();
    await binding.beforeSampling?.(params.maxTokens);
    signal.throwIfAborted();
    const result = await this.services.sampling!.createMessage(params, context);
    signal.throwIfAborted(); await binding.beforeRetry();
    const validated = await this.samplingResult(result, params);
    const approved = await this.review(binding, signal, { mode: "review", kind: "sampling.response", editable: true,
      message: "Review the generated response before disclosing it to the MCP server. Decline withholds the result; it does not undo provider usage.", data: validated });
    if (approved === undefined) throw hostFailure(this.serverId, "sampling response withheld by user");
    const output = await this.samplingResult(approved, params);
    if (output.model !== validated.model) throw hostFailure(this.serverId, "sampling review cannot change the producing model identity");
    await binding.beforeRetry(); signal.throwIfAborted();
    return output;
  }

  private async samplingParams(raw: unknown): Promise<CreateMessageRequestParams> {
    hostBounded(raw, this.serverId, 48 * 1024);
    const parsed = await specTypeSchemas.CreateMessageRequestParams["~standard"].validate(raw);
    if (parsed.issues !== undefined) throw hostFailure(this.serverId, "invalid sampling request");
    const value = parsed.value;
    if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 4096 || value.messages.length > 64) throw hostFailure(this.serverId, "sampling request exceeds token/message limits");
    if (value.includeContext !== undefined && value.includeContext !== "none") throw hostFailure(this.serverId, "implicit sampling Context inclusion is unsupported");
    const historyUsesTools = value.messages.some((message) => (Array.isArray(message.content) ? message.content : [message.content]).some((part) => part.type === "tool_use" || part.type === "tool_result"));
    if ((value.tools !== undefined || value.toolChoice !== undefined || historyUsesTools) && !this.services.sampling!.supportsTools) throw hostFailure(this.serverId, "sampling tools are not enabled");
    if ((value.tools?.length ?? 0) > 32 || new Set(value.tools?.map((tool) => tool.name)).size !== (value.tools?.length ?? 0)) throw hostFailure(this.serverId, "invalid sampling tool list");
    const { _meta: _ignored, task: _task, ...params } = value;
    return structuredClone(params);
  }

  private async samplingResult(raw: unknown, params: CreateMessageRequestParams): Promise<CreateMessageResult | CreateMessageResultWithTools> {
    hostBounded(raw, this.serverId, 48 * 1024);
    const schema = params.tools === undefined ? specTypeSchemas.CreateMessageResult : specTypeSchemas.CreateMessageResultWithTools;
    const parsed = await schema["~standard"].validate(raw);
    if (parsed.issues !== undefined) throw hostFailure(this.serverId, "invalid sampling result");
    const result = parsed.value;
    for (const content of Array.isArray(result.content) ? result.content : [result.content]) {
      if (content.type === "tool_use" && !params.tools?.some((tool) => tool.name === content.name)) throw hostFailure(this.serverId, "sampling proposed an undeclared tool");
    }
    const { _meta: _ignored, ...clean } = result;
    return structuredClone(clean);
  }

  private context(binding: McpInputBinding, signal: AbortSignal): McpHostRequestContext {
    signal.throwIfAborted();
    if (binding.owner === undefined) throw hostFailure(this.serverId, "missing trusted request owner");
    return Object.freeze({ serverId: this.serverId, requestId: binding.id, owner: binding.owner, signal, expiresAt: binding.expiresAt });
  }

  private async review(binding: McpInputBinding, signal: AbortSignal, params: McpHostReviewParams): Promise<unknown | undefined> {
    const response = await this.broker.review(this.serverId, binding.id, binding.owner!, params, signal, binding.expiresAt);
    signal.throwIfAborted();
    if (response.action !== "accept") return undefined;
    return response.content === undefined ? params.data : JSON.parse(response.content.json as string);
  }
}

export function hostFailure(serverId: string, message: string): McpCapabilityError {
  return new McpCapabilityError(serverId, message, "MCP_HOST_REQUEST_ERROR");
}
export function hostBounded(value: unknown, serverId: string, limit = 64 * 1024): void {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > limit) throw hostFailure(serverId, "host request exceeds byte limit");
}
