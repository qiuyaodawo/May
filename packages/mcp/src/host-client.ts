import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Client, SdkError, SdkErrorCode, specTypeSchemas, type RequestOptions, type Tool } from "@modelcontextprotocol/client";
import { McpTaskWire } from "./task-wire.js";
import { object, taskFailure } from "./tasks.js";
import { McpCapabilityError } from "./errors.js";
import type { McpInteractionBroker, McpInteractionOwner } from "./interactions.js";
import { McpHostServiceRunner, hostFailure, type McpHostServices, type McpInputBinding, type McpServerHostOptions } from "./host-services.js";

interface Binding extends McpInputBinding {
  readonly controller: AbortController;
}
const bindingKey = Symbol("may.mcp.host-request");
type ScopedRequest = RequestOptions & { [bindingKey]?: Binding };

/** Uses the SDK's protected MRTR extension seam, never private request maps. */
export class McpHostClient extends Client {
  private readonly activeInput = new AsyncLocalStorage<Binding>();
  private serverId = "";
  private legacyBinding: Binding | undefined;
  private readonly taskWire = new McpTaskWire(() => this.serverId, () => this.transport, () => this._outboundMetaEnvelope());

  protected override _onresponse(...args: Parameters<Client["_onresponse"]>): void {
    if (!this.taskWire.receive(args[0])) super._onresponse(...args);
  }
  protected override _onnotification(...args: Parameters<Client["_onnotification"]>): void {
    if (!this.taskWire.notification(args[0])) super._onnotification(...args);
  }
  protected override _onclose(): void { this.taskWire.close(); super._onclose(); }

  async taskRequest(method: "tools/call" | "tasks/get" | "tasks/update" | "tasks/cancel", params: Record<string, unknown>, options: RequestOptions, definition?: Tool): Promise<Record<string, unknown>> {
    const started = Date.now();
    const result = await this.taskWire.request(method, params, options, definition);
    if (result.resultType !== "input_required") return result;
    if (method !== "tools/call") throw taskFailure(this.serverId, "task management must use task inputRequests, not MRTR");
    const decoded = this._wireCodec().decodeResult(method, result);
    if (decoded.kind !== "input_required") throw taskFailure(this.serverId, "invalid task-creation MRTR result");
    return await this._resolveNonCompleteResult(decoded, { codec: this._wireCodec(), request: { method, params },
      options, flowStartedAt: started, resultSchema: specTypeSchemas.CallToolResult,
      // The driver owns subsequent MRTR rounds; this callback only sends one leg.
      retry: (next, leg) => this.taskWire.request(method, next ?? {}, leg, definition),
    }) as Record<string, unknown>;
  }

  /** Reuse the SDK's registered/validated host handlers without a protocol retry. */
  async fulfillTaskInput(options: RequestOptions, key: string, input: unknown, beforeSampling: (maxTokens: number) => Promise<void>): Promise<unknown> {
    const binding = (options as ScopedRequest)[bindingKey];
    if (binding === undefined) throw taskFailure(this.serverId, "missing task interaction scope");
    binding.beforeSampling = beforeSampling;
    let responses: Record<string, unknown> | undefined;
    try {
      await this._resolveNonCompleteResult({ kind: "input_required", inputRequests: { [key]: input } }, {
        codec: this._wireCodec(), request: { method: "tasks/update" }, resultSchema: specTypeSchemas.EmptyResult,
        options, flowStartedAt: Date.now(), retry: async (params) => {
          if (object(params?.inputResponses)) responses = params.inputResponses;
          return {};
        },
      });
      if (responses === undefined || !Object.hasOwn(responses, key)) throw taskFailure(this.serverId, "task input did not produce a response");
      return responses[key];
    } finally { delete binding.beforeSampling; }
  }

  taskInitialUsage(options: RequestOptions) {
    const binding = (options as ScopedRequest)[bindingKey];
    return { inputs: binding?.count ?? 0, samplingCalls: binding?.samplingCalls ?? 0, samplingTokens: binding?.samplingTokens ?? 0 };
  }
  taskDeadline(options: RequestOptions): number { return (options as ScopedRequest)[bindingKey]?.expiresAt ?? Date.now() + 60_000; }

  configureHost(serverId: string, broker?: McpInteractionBroker, options?: McpServerHostOptions, services?: McpHostServices): void {
    this.serverId = serverId;
    if (broker === undefined) return;
    this.setRequestHandler("elicitation/create", async (request, context) => {
      const binding = this.inputBinding();
      if (binding === undefined) return { action: "decline" };
      const signal = AbortSignal.any([binding.signal, context.mcpReq.signal]);
      const result = await broker.request(serverId, binding.id, binding.owner!, request.params, signal, binding.expiresAt);
      await binding.beforeRetry(); signal.throwIfAborted();
      return result;
    });
    const runner = new McpHostServiceRunner(serverId, broker, services ?? {});
    if (options?.roots && services?.roots) this.setRequestHandler("roots/list", async (_request, context) => {
      const binding = this.inputBinding();
      if (binding === undefined) return { roots: [] };
      const signal = AbortSignal.any([binding.signal, context.mcpReq.signal]);
      return this.hostResult(runner.roots(binding, signal), signal);
    });
    if (options?.sampling && services?.sampling) this.setRequestHandler("sampling/createMessage", async (request, context) => {
      const binding = this.inputBinding();
      if (binding === undefined) throw hostFailure(serverId, "unsolicited sampling is not authorized");
      const signal = AbortSignal.any([binding.signal, context.mcpReq.signal]);
      return this.hostResult(runner.sample(binding, request.params, signal), signal);
    });
  }

  private hostResult<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(hostFailure(this.serverId, "host request cancelled or expired"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void pending.then(resolve, (error: unknown) => reject(this.safeHostError(error))).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  private safeHostError(error: unknown): Error {
    // Filesystem/provider exceptions may contain undisclosed paths or credentials.
    return error instanceof McpCapabilityError && ["MCP_HOST_REQUEST_ERROR", "MCP_INTERACTION_ERROR"].includes(error.code)
      ? error : hostFailure(this.serverId, "host service unavailable, changed, or cancelled");
  }

  private inputBinding(): Binding | undefined {
    // The dedicated legacy channel is assigned ONCE for its only operation.
    // Ordinary multiplexed connections never guess from a currently active Run.
    const binding = this.getProtocolEra() === "modern" ? this.activeInput.getStore() : this.legacyBinding;
    if (binding === undefined) return undefined;
    binding.signal.throwIfAborted();
    if (++binding.count > 32 || binding.owner === undefined) throw hostFailure(this.serverId, "input budget exhausted or missing trusted owner");
    return binding;
  }

  async runScoped<T>(options: RequestOptions, work: () => Promise<T>, isolatedLegacy = false): Promise<T> {
    const binding = (options as ScopedRequest)[bindingKey];
    if (isolatedLegacy && this.getProtocolEra() === "legacy") {
      if (this.legacyBinding !== undefined) throw hostFailure(this.serverId, "legacy channel is already owned");
      this.legacyBinding = binding;
    }
    try { return await work(); }
    finally {
      if (this.legacyBinding === binding) this.legacyBinding = undefined;
      binding?.controller.abort("MCP logical operation completed");
    }
  }

  scope(options: RequestOptions, owner: McpInteractionOwner | undefined, lifetime: AbortSignal, beforeRetry: () => Promise<void>): RequestOptions {
    const timeout = options.maxTotalTimeout ?? 60_000;
    const controller = new AbortController();
    const signal = AbortSignal.any([lifetime, controller.signal, AbortSignal.timeout(Math.ceil(timeout)), ...(options.signal === undefined ? [] : [options.signal])]);
    const binding: Binding = { id: randomUUID(), owner: owner === undefined ? undefined : Object.freeze({ ...owner }), signal, expiresAt: Date.now() + timeout, beforeRetry, controller, count: 0, samplingCalls: 0, samplingTokens: 0 };
    const scoped: ScopedRequest = { ...options, signal, maxTotalTimeout: timeout, [bindingKey]: binding };
    return scoped;
  }

  protected override _resolveNonCompleteResult(...args: Parameters<Client["_resolveNonCompleteResult"]>): Promise<unknown> {
    const [decoded, flow] = args;
    const binding = (flow.options as ScopedRequest | undefined)?.[bindingKey];
    if (binding === undefined || Object.keys(decoded.inputRequests).length > 32) {
      return Promise.reject(new McpCapabilityError(this.serverId, "unscoped or oversized input-required flow", "MCP_INTERACTION_ERROR"));
    }
    // This local-only options symbol is not MCP _meta and never crosses the wire.
    // The SDK retains one whole-flow budget and echoes opaque state unchanged.
    const guardedFlow: typeof flow = { ...flow, retry: async (params, options) => {
      binding.signal.throwIfAborted();
      await binding.beforeRetry();
      binding.signal.throwIfAborted();
      return flow.retry(params, options);
    } };
    return this.activeInput.run(binding, () => super._resolveNonCompleteResult(decoded, guardedFlow)).catch((error: unknown) => {
      if (binding.signal.aborted) throw new McpCapabilityError(this.serverId, "input-required flow cancelled or timeout exceeded", "MCP_INTERACTION_ERROR");
      if (error instanceof SdkError && error.code === SdkErrorCode.InputRequiredRoundsExceeded) throw new McpCapabilityError(this.serverId, "input-required flow exceeded 8 rounds", "MCP_INTERACTION_ERROR");
      throw error;
    });
  }
}

export function mcpOwner(scope: Readonly<Record<string, string>> | undefined, runId?: string, toolCallId?: string): McpInteractionOwner | undefined {
  if (!scope?.workspaceId || !scope.sessionId) return undefined;
  return { workspaceId: scope.workspaceId, sessionId: scope.sessionId,
    ...(runId === undefined ? {} : { runId }), ...(toolCallId === undefined ? {} : { toolCallId }) };
}
