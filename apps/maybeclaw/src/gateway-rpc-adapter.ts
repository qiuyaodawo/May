import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { createMessageConnection, ErrorCodes, ResponseError, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node";
import type { AgentApplicationEvent } from "@may/application";
import type { ContentPart } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type { GatewayAdapterContext, GatewayAgentAdapter, GatewayAgentConfig, GatewayCapabilities, GatewayTaskStatus } from "./gateway-types.js";

export type GatewayRpcOptions = {
  transport: "stdio"; command: string; args?: string[]; cwd?: string; env?: Record<string, string>; timeoutMs?: number; executionTimeoutMs?: number;
} | {
  transport: "socket"; path?: string; host?: string; port?: number; timeoutMs?: number; executionTimeoutMs?: number;
};
interface RpcFactoryOptions { agent: GatewayAgentConfig; options: Record<string, unknown> }
interface RpcTransport { connection: MessageConnection; process?: ChildProcessWithoutNullStreams; socket?: Socket }
interface RpcHandshake { protocolVersion: number; capabilities: GatewayCapabilities; commands?: string[] }
export class RpcOutcomeUnknownError extends Error {
  readonly outcome = "unknown";
  constructor(readonly method: string, readonly requestId?: string) { super(`RPC ${method} 的结果未能确认，请按原请求 ID 查询状态。`); }
}

export async function createAdapter(factory: RpcFactoryOptions): Promise<GatewayAgentAdapter> {
  return createGatewayRpcAdapter(factory.agent.id, parseRpcOptions(factory.options));
}

export async function createGatewayRpcAdapter(agentId: string, options: GatewayRpcOptions): Promise<GatewayAgentAdapter> {
  const validated = parseRpcOptions(options);
  const open = async () => {
    const adapter = new RpcAdapter(agentId, validated, await connect(validated));
    try { await adapter.initialize(); return adapter; }
    catch (error) { await adapter.close(); throw error; }
  };
  let adapter = await open(), reconnecting: Promise<RpcAdapter> | undefined, closed = false;
  const queryAdapter = async (): Promise<RpcAdapter> => {
    if (closed) throw new Error("RPC adapter is closed");
    if (adapter.connected) return adapter;
    return reconnecting ??= (async () => {
      const previous = adapter.capabilities;
      await adapter.close();
      const reopened = await open();
      if (JSON.stringify(previous) !== JSON.stringify(reopened.capabilities)) { await reopened.close(); throw new Error("RPC capabilities changed; update the Agent configuration before continuing"); }
      adapter = reopened;
      return adapter;
    })().finally(() => { reconnecting = undefined; });
  };
  return {
    get capabilities() { return adapter.capabilities; },
    createConversation: requestId => adapter.createConversation(requestId),
    inspectCreation: async requestId => (await queryAdapter()).inspectCreation(requestId),
    execute: context => adapter.execute(context),
    inspect: async (conversationId, inputId) => (await queryAdapter()).inspect(conversationId, inputId),
    cancel: conversationId => adapter.cancel(conversationId),
    steer: (conversationId, text, inputId) => adapter.steer(conversationId, text, inputId),
    steeringInputs: async conversationId => (await queryAdapter()).steeringInputs(conversationId),
    resolveApproval: (conversationId, requestId, decision) => adapter.resolveApproval(conversationId, requestId, decision),
    release: conversationId => adapter.release(conversationId),
    deleteConversation: conversationId => adapter.deleteConversation(conversationId),
    command: (conversationId, name, args) => adapter.command(conversationId, name, args),
    close: async () => { if (closed) return; closed = true; await reconnecting; await adapter.close(); },
  };
}

class RpcAdapter implements GatewayAgentAdapter {
  private handshake: RpcHandshake | undefined;
  private closed = false;
  private disconnected = false;
  private readonly executions = new Map<string, GatewayAdapterContext>();
  private readonly cancellations = new Map<string, Promise<void>>();
  private readonly toolCalls = new Map<string, { name: string; input: string; result: Promise<unknown> }>();
  constructor(private readonly agentId: string, private readonly options: GatewayRpcOptions, private readonly transport: RpcTransport) {
    transport.connection.onClose(() => { this.disconnected = true; transport.connection.dispose(); });
    transport.connection.onError(() => { this.disconnected = true; transport.connection.dispose(); });
    transport.connection.onNotification("gateway/event", (value: unknown) => {
      const item = object(value, "event"), context = this.context(item);
      const event = object(item.event, "application event");
      if (!["run.event", "permission.event", "tool.presentation", "context.compacted", "context.compaction.failed"].includes(String(event.type))) throw new Error("Unsupported RPC application event");
      context.report(event as unknown as AgentApplicationEvent);
    });
    transport.connection.onRequest("gateway/shouldYield", (value: unknown) => this.context(object(value, "yield request")).shouldYield());
    transport.connection.onRequest("gateway/tool", async (value: unknown) => {
      const item = object(value, "tool request"), context = this.context(item);
      if (!this.capabilities.collaboration) throw new Error("RPC collaboration is not supported");
      const name = string(item.name, "tool name"), callId = string(item.callId, "call ID");
      const tool = context.tools.find(value => value.name === name);
      if (!tool) throw new Error("RPC tool is unavailable in this execution");
      if (!Number.isSafeInteger(item.step) || (item.step as number) < 0) throw new Error("Invalid RPC tool step");
      const key = JSON.stringify([context.conversationId, context.inputId, callId]);
      const encoded = JSON.stringify(item.input);
      if (encoded === undefined) throw new Error("RPC tool input is required");
      const previous = this.toolCalls.get(key);
      if (previous) {
        if (previous.name !== name || previous.input !== encoded) throw new Error("RPC tool request identity conflict");
        return previous.result;
      }
      context.signal.throwIfAborted();
      const result = tool.execute(tool.parse ? tool.parse(item.input) : item.input, {
        runId: context.inputId, step: item.step as number, toolCallId: callId, idempotencyKey: key, signal: context.signal,
        report: update => { void transport.connection.sendNotification("gateway/toolProgress", { conversationId: context.conversationId, inputId: context.inputId, callId, update }); },
      });
      this.toolCalls.set(key, { name, input: encoded, result });
      return result;
    });
    transport.connection.listen();
  }
  get connected(): boolean { return !this.closed && !this.disconnected; }
  get capabilities(): GatewayCapabilities {
    if (!this.handshake) throw new Error("RPC handshake has not completed");
    return this.handshake.capabilities;
  }
  async initialize(): Promise<void> {
    const result = object(await this.request("gateway/initialize", { protocolVersion: 1, agentId: this.agentId }), "handshake");
    if (result.protocolVersion !== 1) throw new Error("Unsupported Gateway RPC protocol version");
    const capabilities = object(result.capabilities, "capabilities");
    for (const key of ["cancel", "steer", "resume", "delete", "approvals", "collaboration"] as const) if (typeof capabilities[key] !== "boolean") throw new Error(`RPC capability ${key} must be boolean`);
    if (!Array.isArray(capabilities.media) || capabilities.media.some(value => typeof value !== "string" || !["image", "audio", "file", "video"].includes(value)) || new Set(capabilities.media).size !== capabilities.media.length) throw new Error("Invalid RPC media capabilities");
    if (result.commands !== undefined && (!Array.isArray(result.commands) || result.commands.some(value => typeof value !== "string" || !value))) throw new Error("Invalid RPC commands");
    this.handshake = { protocolVersion: 1, capabilities: Object.freeze(structuredClone(capabilities)) as unknown as GatewayCapabilities, ...(result.commands ? { commands: result.commands as string[] } : {}) };
  }
  async createConversation(requestId: string): Promise<string> {
    const result = object(await this.request("conversation/create", { requestId }, requestId), "created conversation");
    return string(result.conversationId, "conversation ID");
  }
  async inspectCreation(requestId: string): Promise<{ status: "not-started" | "ready" | "unknown"; conversationId?: string }> {
    const result = object(await this.request("conversation/inspectCreation", { requestId }, requestId), "creation status");
    if (!["not-started", "ready", "unknown"].includes(String(result.status))) throw new Error("Invalid RPC creation status");
    if (result.status === "ready") return { status: "ready", conversationId: string(result.conversationId, "conversation ID") };
    return { status: result.status as "not-started" | "unknown" };
  }
  async execute(context: GatewayAdapterContext): Promise<{ text: string; runId?: string; yielded?: boolean; content?: ContentPart[] }> {
    context.signal.throwIfAborted();
    if (this.executions.has(context.conversationId)) throw new Error("RPC conversation is already running");
    this.cancellations.delete(context.conversationId);
    this.executions.set(context.conversationId, context);
    let cancellationError: unknown;
    const abort = () => { if (this.capabilities.cancel) void this.cancel(context.conversationId).catch(error => { cancellationError = error; }); };
    context.signal.addEventListener("abort", abort, { once: true });
    try {
      const result = object(await this.request("conversation/execute", { conversationId: context.conversationId, inputId: context.inputId, input: context.input,
        tools: this.capabilities.collaboration ? context.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) : [] }, context.inputId, this.options.executionTimeoutMs ?? 0), "execution result");
      const cancellation = this.cancellations.get(context.conversationId);
      if (cancellation) await cancellation;
      if (cancellationError) throw cancellationError;
      if (typeof result.text !== "string" || (result.yielded !== undefined && typeof result.yielded !== "boolean")) throw new Error("Invalid RPC execution result");
      const content = result.content === undefined ? undefined : contentParts(result.content);
      return { text: result.text, ...(result.runId === undefined ? {} : { runId: string(result.runId, "run ID") }), ...(result.yielded === undefined ? {} : { yielded: result.yielded as boolean }), ...(content ? { content } : {}) };
    } finally {
      context.signal.removeEventListener("abort", abort);
      this.executions.delete(context.conversationId);
      this.cancellations.delete(context.conversationId);
      for (const key of this.toolCalls.keys()) if (key.startsWith(JSON.stringify([context.conversationId, context.inputId]).slice(0, -1) + ",")) this.toolCalls.delete(key);
    }
  }
  async inspect(conversationId: string, inputId: string): Promise<{ status: "not-started" | GatewayTaskStatus; text?: string; detail?: string; content?: ContentPart[]; runId?: string }> {
    const result = object(await this.request("conversation/inspect", { conversationId, inputId }, inputId), "execution status");
    if (!["not-started", "queued", "running", "waiting", "cancelling", "completed", "failed", "cancelled", "recovery-required"].includes(String(result.status))) throw new Error("Invalid RPC execution status");
    if ((result.text !== undefined && typeof result.text !== "string") || (result.detail !== undefined && typeof result.detail !== "string")) throw new Error("Invalid RPC execution status content");
    const content = result.content === undefined ? undefined : contentParts(result.content);
    return { status: result.status as "not-started" | GatewayTaskStatus, ...(result.text === undefined ? {} : { text: result.text as string }), ...(result.detail === undefined ? {} : { detail: result.detail as string }),
      ...(content ? { content } : {}), ...(result.runId === undefined ? {} : { runId: string(result.runId, "run ID") }) };
  }
  cancel(conversationId: string): Promise<void> {
    this.require("cancel");
    const previous = this.cancellations.get(conversationId);
    if (previous) return previous;
    const operation = this.request("conversation/cancel", { conversationId }).then(value => {
      if (object(value, "cancellation").cancelled !== true) throw new Error("RPC cancellation was not confirmed");
    });
    this.cancellations.set(conversationId, operation);
    return operation;
  }
  async steer(conversationId: string, text: string, inputId: string): Promise<{ status: string }> {
    this.require("steer");
    const result = object(await this.request("conversation/steer", { conversationId, text, inputId }, inputId), "steer result");
    const status = string(result.status, "steer status");
    if (!["pending", "idle", "delivered", "cancelled"].includes(status)) throw new Error("Invalid RPC steer status");
    return { status };
  }
  async steeringInputs(conversationId: string): Promise<readonly { inputId: string; text: string; status: string }[]> {
    this.require("steer");
    const result = await this.request("conversation/steeringInputs", { conversationId });
    if (!Array.isArray(result)) throw new Error("Invalid RPC steering inputs");
    const ids = new Set<string>();
    return result.map(value => {
      const item = object(value, "steering input"), inputId = string(item.inputId, "steering input ID");
      if (ids.has(inputId) || typeof item.text !== "string" || !["pending", "idle", "delivered", "cancelled"].includes(String(item.status))) throw new Error("Invalid RPC steering input state");
      ids.add(inputId);
      return { inputId, text: item.text, status: item.status as string };
    });
  }
  async resolveApproval(conversationId: string, requestId: string, decision: ApprovalDecision): Promise<boolean> {
    this.require("approvals");
    const result = object(await this.request("conversation/resolveApproval", { conversationId, requestId, decision }, requestId), "approval result");
    if (typeof result.resolved !== "boolean") throw new Error("Invalid RPC approval result");
    return result.resolved;
  }
  async release(conversationId: string): Promise<void> {
    if (this.executions.has(conversationId)) throw new Error("Cannot release a running RPC conversation");
    if (object(await this.request("conversation/release", { conversationId }), "release result").released !== true) throw new Error("RPC resource release was not confirmed");
  }
  async deleteConversation(conversationId: string): Promise<void> {
    this.require("delete");
    if (this.executions.has(conversationId)) throw new Error("Cannot delete a running RPC conversation");
    if (object(await this.request("conversation/delete", { conversationId }), "deletion result").deleted !== true) throw new Error("RPC conversation deletion was not confirmed");
  }
  async command(conversationId: string, name: string, args: readonly string[]): Promise<string> {
    if (["new", "resume"].includes(name.replace(/^\//, "")) || !this.handshake?.commands?.includes(name)) throw new Error("Unsupported RPC Agent command");
    const result = object(await this.request("conversation/command", { conversationId, name, args }), "command result");
    if (typeof result.text !== "string") throw new Error("Invalid RPC command result");
    return result.text;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.transport.connection.dispose();
    this.transport.socket?.destroy();
    const child = this.transport.process;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  private context(item: Record<string, unknown>): GatewayAdapterContext {
    const context = this.executions.get(string(item.conversationId, "conversation ID"));
    if (!context || context.inputId !== item.inputId) throw new Error("RPC callback does not belong to an active execution");
    return context;
  }
  private require(name: "cancel" | "steer" | "delete" | "approvals"): void { if (!this.capabilities[name]) throw new Error(`RPC capability ${name} is unavailable`); }
  private async request(method: string, params: object, requestId?: string, timeoutMs = this.options.timeoutMs ?? 30_000): Promise<unknown> {
    if (this.closed) throw new Error("RPC adapter is closed");
    if (this.disconnected) throw new RpcOutcomeUnknownError(method, requestId);
    let timer: NodeJS.Timeout | undefined;
    try {
      const operation = this.transport.connection.sendRequest(method, params);
      if (!timeoutMs) return await operation;
      return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RpcOutcomeUnknownError(method, requestId)), timeoutMs); })]);
    } catch (error) {
      if (error instanceof RpcOutcomeUnknownError) throw error;
      const transportCodes: readonly number[] = [ErrorCodes.MessageReadError, ErrorCodes.MessageWriteError, ErrorCodes.PendingResponseRejected, ErrorCodes.ConnectionInactive];
      if (error instanceof ResponseError && !transportCodes.includes(error.code)) throw error;
      throw new RpcOutcomeUnknownError(method, requestId);
    } finally { if (timer) clearTimeout(timer); }
  }
}

async function connect(options: GatewayRpcOptions): Promise<RpcTransport> {
  const timeout = options.timeoutMs ?? 30_000;
  if (options.transport === "stdio") {
    const child = spawn(options.command, options.args ?? [], { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "pipe", windowsHide: true, shell: false });
    child.stderr.resume();
    await once(child, "spawn");
    return { connection: createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin)), process: child };
  }
  const socket = options.path ? createConnection(options.path) : createConnection({ host: options.host ?? "127.0.0.1", port: options.port! });
  const timer = setTimeout(() => socket.destroy(new Error("RPC socket connection timed out")), timeout);
  try { await once(socket, "connect"); }
  finally { clearTimeout(timer); }
  return { connection: createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket)), socket };
}
function parseRpcOptions(value: unknown): GatewayRpcOptions {
  const options = object(value, "RPC options");
  if (options.transport !== "stdio" && options.transport !== "socket") throw new Error("RPC transport must be stdio or socket");
  for (const key of ["timeoutMs", "executionTimeoutMs"] as const) if (options[key] !== undefined && (!Number.isSafeInteger(options[key]) || (options[key] as number) < (key === "timeoutMs" ? 1 : 0))) throw new Error(`Invalid RPC ${key}`);
  if (options.transport === "stdio") {
    string(options.command, "command");
    if (options.args !== undefined && (!Array.isArray(options.args) || options.args.some(arg => typeof arg !== "string" || arg.includes("\0")))) throw new Error("Invalid RPC command arguments");
    if (options.cwd !== undefined) string(options.cwd, "cwd");
    if (options.env !== undefined && Object.values(object(options.env, "environment")).some(value => typeof value !== "string" || value.includes("\0"))) throw new Error("Invalid RPC environment");
  } else {
    if (options.path !== undefined) {
      string(options.path, "socket path");
      if (options.host !== undefined || options.port !== undefined) throw new Error("Specify a socket path or host and port");
    } else {
      if (!Number.isSafeInteger(options.port) || (options.port as number) < 1 || (options.port as number) > 65535) throw new Error("Invalid RPC socket port");
      if (options.host !== undefined) string(options.host, "socket host");
    }
  }
  return structuredClone(options) as GatewayRpcOptions;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid RPC ${label}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error(`Invalid RPC ${label}`);
  return value;
}
function contentParts(value: unknown): ContentPart[] {
  if (!Array.isArray(value)) throw new Error("Invalid RPC result content");
  for (const item of value) {
    const part = object(item, "content part");
    if (part.type === "text" || part.type === "reasoning") {
      if (typeof part.text !== "string") throw new Error("Invalid RPC content text");
    } else if (["image", "file", "audio"].includes(String(part.type))) {
      const source = object(part.source, "media source");
      if (source.type === "base64") { string(source.mediaType, "media type"); string(source.data, "media data"); }
      else if (source.type === "url") string(source.url, "media URL");
      else if (source.type === "file") string(source.fileId, "file ID");
      else throw new Error("Invalid RPC media source type");
      if (part.name !== undefined) string(part.name, "file name");
    } else if (part.type === "resource") string(part.uri, "resource URI");
    else if (part.type !== "json") throw new Error("Invalid RPC content part type");
  }
  return value as ContentPart[];
}
