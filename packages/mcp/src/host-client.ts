import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Client, SdkError, SdkErrorCode, type RequestOptions } from "@modelcontextprotocol/client";
import { McpCapabilityError } from "./errors.js";
import type { McpInteractionBroker, McpInteractionOwner } from "./interactions.js";

interface Binding {
  readonly id: string;
  readonly owner: McpInteractionOwner | undefined;
  readonly signal: AbortSignal;
  readonly expiresAt: number;
  readonly beforeRetry: () => Promise<void>;
  count: number;
}
const bindingKey = Symbol("may.mcp.host-request");
type ScopedRequest = RequestOptions & { [bindingKey]?: Binding };

/** Uses the SDK's protected MRTR extension seam, never private request maps. */
export class McpHostClient extends Client {
  private readonly activeInput = new AsyncLocalStorage<Binding>();
  private serverId = "";

  configureHost(serverId: string, broker?: McpInteractionBroker): void {
    this.serverId = serverId;
    if (broker === undefined) return;
    this.setRequestHandler("elicitation/create", async (request, context) => {
      const binding = this.activeInput.getStore();
      // Legacy push requests do not carry a trustworthy logical parent. Never
      // infer ownership from whichever Run happens to be active on a connection.
      if (this.getProtocolEra() !== "modern" || binding === undefined) return { action: "decline" };
      binding.signal.throwIfAborted();
      if (++binding.count > 32 || binding.owner === undefined) throw new McpCapabilityError(serverId, "interaction budget exhausted or missing trusted owner", "MCP_INTERACTION_ERROR");
      return broker.request(serverId, binding.id, binding.owner, request.params,
        AbortSignal.any([binding.signal, context.mcpReq.signal]), binding.expiresAt);
    });
  }

  scope(options: RequestOptions, owner: McpInteractionOwner | undefined, lifetime: AbortSignal, beforeRetry: () => Promise<void>): RequestOptions {
    const timeout = options.maxTotalTimeout ?? 60_000;
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(Math.ceil(timeout)), ...(options.signal === undefined ? [] : [options.signal])]);
    const binding: Binding = { id: randomUUID(), owner: owner === undefined ? undefined : Object.freeze({ ...owner }), signal, expiresAt: Date.now() + timeout, beforeRetry, count: 0 };
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
