import type { ContextSnapshot } from "./context.js";
import type { RunResult, SerializedError } from "./events.js";
import type { ModelEvent, ModelRequest } from "./model.js";
import type { ToolProgressUpdate } from "./tool.js";
import type { ContentPart, Message, ToolCall, UserMessage } from "./types.js";

/** @experimental */
export interface HookContext {
  readonly signal: AbortSignal;
  readonly runId?: string;
  readonly step?: number;
  readonly sessionId?: string;
}

/** @experimental */
export interface HookDefinition<T> {
  readonly name: string;
  readonly kind: "transform" | "observe";
  readonly validate: (value: unknown) => T;
  readonly failure?: "propagate" | "isolate";
  readonly allowAborted?: boolean;
}

/** @experimental */
export interface HookDispatcher {
  transform<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<T>;
  observe<T>(hook: HookDefinition<T>, value: T, context: HookContext): Promise<void>;
}

/** @experimental */
export function defineHook<T>(definition: HookDefinition<T>): HookDefinition<T> {
  if (typeof definition.name !== "string" || definition.name.trim() === "")
    throw new TypeError("Hook name cannot be empty");
  if (definition.kind !== "transform" && definition.kind !== "observe") throw new TypeError("Invalid Hook kind");
  if (typeof definition.validate !== "function") throw new TypeError("Hook requires a validator");
  if (definition.failure !== undefined && definition.failure !== "propagate" && definition.failure !== "isolate")
    throw new TypeError("Invalid Hook failure policy");
  if (definition.allowAborted !== undefined && typeof definition.allowAborted !== "boolean")
    throw new TypeError("allowAborted must be boolean");
  if (definition.kind === "transform" && definition.failure === "isolate")
    throw new TypeError("Transform Hook failures must propagate");
  return Object.freeze({ ...definition });
}

/** @experimental */
export interface RunStartHook {
  readonly continuation: boolean;
}

/** @experimental */
export interface RunSettleHook {
  readonly result: RunResult;
  readonly continueMessages: readonly UserMessage[];
  readonly reason?: string;
}

/** @experimental */
export interface ToolInputHook {
  readonly call: ToolCall;
  readonly input: unknown;
  readonly denyReason?: string;
}

/** @experimental */
export interface ToolResultHook {
  readonly call: ToolCall;
  readonly content: readonly ContentPart[];
}

/** @experimental */
export interface ToolOutcomeHook extends ToolResultHook {
  readonly output: unknown;
}

/** @experimental */
export interface ToolProgressHook {
  readonly call: ToolCall;
  readonly update: ToolProgressUpdate;
}

/** @experimental */
export interface HookFailure {
  readonly error: SerializedError;
}

/** @experimental */
export interface ToolFailureHook extends HookFailure {
  readonly call: ToolCall;
}

/** @experimental */
export const runtimeHooks = Object.freeze({
  runBefore: defineHook<RunStartHook>({ name: "run.before", kind: "observe", validate: validateRunStart }),
  runStarted: defineHook<RunStartHook>({ name: "run.started", kind: "observe", validate: validateRunStart }),
  runBeforeEnd: defineHook<RunSettleHook>({ name: "run.beforeEnd", kind: "transform", validate: validateRunSettle }),
  runEnded: defineHook<RunResult>({
    name: "run.ended",
    kind: "observe",
    validate: validateRunResult,
    allowAborted: true,
  }),
  runFailed: defineHook<HookFailure>({
    name: "run.failed",
    kind: "observe",
    validate: validateFailure,
    allowAborted: true,
  }),
  stepBefore: defineHook<{ readonly step: number }>({ name: "step.before", kind: "observe", validate: validateStep }),
  stepCompleted: defineHook<{ readonly step: number }>({
    name: "step.completed",
    kind: "observe",
    validate: validateStep,
  }),
  contextBefore: defineHook<{ readonly step: number }>({
    name: "context.before",
    kind: "observe",
    validate: validateStep,
  }),
  contextAfter: defineHook<ContextSnapshot>({
    name: "context.after",
    kind: "transform",
    validate: validateContextSnapshot,
  }),
  modelBefore: defineHook<ModelRequest>({ name: "model.before", kind: "transform", validate: validateModelRequest }),
  modelEvent: defineHook<ModelEvent>({ name: "model.event", kind: "observe", validate: validateModelEvent }),
  modelAfter: defineHook<{ readonly message: Message }>({
    name: "model.after",
    kind: "observe",
    validate: validateMessageEnvelope,
  }),
  modelFailed: defineHook<HookFailure>({
    name: "model.failed",
    kind: "observe",
    validate: validateFailure,
    allowAborted: true,
  }),
  toolBefore: defineHook<ToolInputHook>({ name: "tool.before", kind: "transform", validate: validateToolInput }),
  toolProgress: defineHook<ToolProgressHook>({
    name: "tool.progress",
    kind: "observe",
    validate: validateToolProgress,
  }),
  toolResult: defineHook<ToolResultHook>({ name: "tool.result", kind: "transform", validate: validateToolResult }),
  toolAfter: defineHook<ToolOutcomeHook>({ name: "tool.after", kind: "observe", validate: validateToolOutcome }),
  toolFailed: defineHook<ToolFailureHook>({
    name: "tool.failed",
    kind: "observe",
    validate: validateToolFailure,
    allowAborted: true,
  }),
});

/** @experimental */
export const RUNTIME_HOOKS: readonly HookDefinition<unknown>[] = Object.freeze(Object.values(runtimeHooks));

/** @experimental */
export function validateContextSnapshot(value: unknown): ContextSnapshot {
  const data = record(value, "Context snapshot");
  validateMessages(data.messages);
  optionalString(data.instructions, "instructions");
  if (data.metadata !== undefined) record(data.metadata, "metadata");
  return value as ContextSnapshot;
}

/** @experimental */
export function validateModelRequest(value: unknown): ModelRequest {
  const data = record(value, "Model request");
  validateMessages(data.messages);
  if (!Array.isArray(data.tools)) throw new TypeError("Model tools must be an array");
  const names = new Set<string>();
  for (const entry of data.tools) {
    const tool = record(entry, "Tool definition");
    nonEmpty(tool.name, "Tool name");
    if (names.has(tool.name as string)) throw new TypeError("Model tools must have unique names");
    names.add(tool.name as string);
    if (typeof tool.description !== "string") throw new TypeError("Tool description must be a string");
    record(tool.inputSchema, "Tool input schema");
  }
  if (data.metadata !== undefined) record(data.metadata, "metadata");
  return value as ModelRequest;
}

/** @experimental */
export function validateMessages(value: unknown): asserts value is readonly Message[] {
  if (!Array.isArray(value)) throw new TypeError("Messages must be an array");
  const pending = new Map<string, ToolCall>();
  for (const item of value) {
    const message = validateMessage(item);
    if (message.role === "tool") {
      const call = pending.get(message.toolCallId);
      if (call === undefined || call.name !== message.name)
        throw new TypeError("Tool message must match an unresolved assistant call");
      pending.delete(message.toolCallId);
    } else {
      if (pending.size > 0) throw new TypeError("Tool calls require results before the next conversation message");
      if (message.role === "assistant") {
        for (const call of message.toolCalls ?? []) pending.set(call.id, call);
      }
    }
  }
  if (pending.size > 0) throw new TypeError("Model view contains tool calls without results");
}

/** @experimental */
export function validateMessage(value: unknown): Message {
  const data = record(value, "Message");
  if (!["system", "user", "assistant", "tool"].includes(data.role as string))
    throw new TypeError("Invalid message role");
  validateContent(data.content);
  if (data.role === "tool") {
    nonEmpty(data.toolCallId, "toolCallId");
    nonEmpty(data.name, "Tool name");
    if (data.isError !== undefined && typeof data.isError !== "boolean") throw new TypeError("isError must be boolean");
  }
  if (data.role === "assistant" && data.toolCalls !== undefined) {
    if (!Array.isArray(data.toolCalls)) throw new TypeError("toolCalls must be an array");
    const ids = new Set<string>();
    for (const call of data.toolCalls) {
      validateCall(call);
      if (ids.has(call.id)) throw new TypeError("toolCalls must have unique identities");
      ids.add(call.id);
    }
  }
  if (data.modelState !== undefined) {
    const state = record(data.modelState, "modelState");
    nonEmpty(state.type, "modelState type");
    if (!("data" in state)) throw new TypeError("modelState requires data");
  }
  if (data.role === "assistant") {
    if (data.serverToolCalls !== undefined) {
      if (!Array.isArray(data.serverToolCalls)) throw new TypeError("serverToolCalls must be an array");
      const ids = new Set<string>();
      for (const call of data.serverToolCalls) {
        validateServerToolCall(call);
        if (ids.has(call.id)) throw new TypeError("serverToolCalls must have unique identities");
        ids.add(call.id);
      }
    }
    if (data.continuation !== undefined) {
      if (data.continuation !== "server-tool-pause") throw new TypeError("Invalid assistant continuation");
      if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0)
        throw new TypeError("Assistant continuation cannot contain client tool calls");
    }
  }
  return value as Message;
}

function validateServerToolCall(value: unknown): asserts value is import("./types.js").ServerToolCall {
  const call = record(value, "Server tool call");
  nonEmpty(call.id, "Server tool call id");
  nonEmpty(call.kind, "Server tool call kind");
  nonEmpty(call.name, "Server tool call name");
  if (!["pending", "completed", "failed"].includes(call.status as string))
    throw new TypeError("Invalid server tool call status");
  if (call.sources !== undefined) {
    if (!Array.isArray(call.sources)) throw new TypeError("Server tool sources must be an array");
    for (const source of call.sources) {
      const data = record(source, "Server tool source");
      nonEmpty(data.url, "Server tool source URL");
      optionalString(data.title, "Server tool source title");
      optionalString(data.published, "Server tool source published");
    }
  }
  if (call.error !== undefined) nonEmpty(record(call.error, "Server tool error").code, "Server tool error code");
}

/** @experimental */
export function validateContent(value: unknown): asserts value is readonly ContentPart[] {
  if (!Array.isArray(value)) throw new TypeError("Message content must be an array");
  for (const entry of value) {
    const part = record(entry, "Content part");
    switch (part.type) {
      case "text":
      case "reasoning":
        if (typeof part.text !== "string") throw new TypeError("Content text must be a string");
        if (part.type === "text" && part.citations !== undefined) {
          if (!Array.isArray(part.citations)) throw new TypeError("citations must be an array");
          for (const entry of part.citations) {
            const citation = record(entry, "Citation");
            if (citation.type !== "url") throw new TypeError("Invalid citation type");
            nonEmpty(citation.url, "Citation URL");
            optionalString(citation.title, "Citation title");
            optionalString(citation.citedText, "Citation citedText");
            if (citation.range !== undefined) {
              const range = record(citation.range, "Citation range");
              if (
                !Number.isSafeInteger(range.start) ||
                !Number.isSafeInteger(range.end) ||
                (range.start as number) < 0 ||
                (range.end as number) < (range.start as number) ||
                (range.end as number) > part.text.length
              )
                throw new TypeError("Invalid citation range");
            }
          }
        }
        break;
      case "json":
        if (!("value" in part)) throw new TypeError("JSON content requires value");
        break;
      case "resource":
        nonEmpty(part.uri, "Resource URI");
        optionalString(part.name, "Resource name");
        optionalString(part.mediaType, "Resource mediaType");
        break;
      case "image":
      case "audio":
      case "file": {
        const source = record(part.source, "Media source");
        if (source.type === "url") nonEmpty(source.url, "Media URL");
        else if (source.type === "file") nonEmpty(source.fileId, "Media fileId");
        else if (source.type === "base64") {
          nonEmpty(source.mediaType, "Media mediaType");
          if (typeof source.data !== "string") throw new TypeError("Media data must be a string");
        } else throw new TypeError("Invalid media source");
        if (part.detail !== undefined && !["auto", "low", "high"].includes(part.detail as string))
          throw new TypeError("Invalid image detail");
        optionalString(part.name, "File name");
        break;
      }
      default:
        throw new TypeError("Invalid content part type");
    }
  }
}

function validateRunStart(value: unknown): RunStartHook {
  const data = record(value, "Run start");
  if (typeof data.continuation !== "boolean") throw new TypeError("continuation must be boolean");
  return value as RunStartHook;
}

function validateRunSettle(value: unknown): RunSettleHook {
  const data = record(value, "Run settlement");
  validateRunResult(data.result);
  validateMessages(data.continueMessages);
  if ((data.continueMessages as Message[]).some((message) => message.role !== "user"))
    throw new TypeError("Continuation messages must be user messages");
  optionalString(data.reason, "Continuation reason");
  if ((data.continueMessages as Message[]).length > 0) nonEmpty(data.reason, "Continuation reason");
  return value as RunSettleHook;
}

function validateRunResult(value: unknown): RunResult {
  const data = record(value, "Run result");
  nonEmpty(data.runId, "runId");
  for (const name of ["steps", "modelCalls", "toolCalls"]) {
    if (!Number.isSafeInteger(data[name]) || (data[name] as number) < 0)
      throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  if (validateMessage(data.message).role !== "assistant") throw new TypeError("Run result requires assistant message");
  if (data.finishReason !== undefined && data.finishReason !== "yielded") throw new TypeError("Invalid finishReason");
  return value as RunResult;
}

function validateStep(value: unknown): { readonly step: number } {
  const data = record(value, "Step");
  if (!Number.isSafeInteger(data.step) || (data.step as number) < 1)
    throw new TypeError("step must be a positive safe integer");
  return value as { readonly step: number };
}

function validateToolInput(value: unknown): ToolInputHook {
  const data = record(value, "Tool input");
  validateCall(data.call);
  if (!("input" in data)) throw new TypeError("Tool input requires input");
  optionalString(data.denyReason, "denyReason");
  return value as ToolInputHook;
}

function validateToolResult(value: unknown): ToolResultHook {
  const data = record(value, "Tool result");
  validateCall(data.call);
  validateContent(data.content);
  return value as ToolResultHook;
}

function validateToolOutcome(value: unknown): ToolOutcomeHook {
  validateToolResult(value);
  if (!("output" in record(value, "Tool outcome"))) throw new TypeError("Tool outcome requires output");
  return value as ToolOutcomeHook;
}

function validateToolProgress(value: unknown): ToolProgressHook {
  const data = record(value, "Tool progress");
  validateCall(data.call);
  const update = record(data.update, "Tool progress update");
  if (update.type === "progress") {
    if (typeof update.message !== "string") throw new TypeError("Progress message must be a string");
  } else if (update.type === "output.delta") {
    if (typeof update.delta !== "string") throw new TypeError("Output delta must be a string");
    optionalString(update.channel, "Output channel");
  } else throw new TypeError("Invalid tool progress update");
  return value as ToolProgressHook;
}

function validateMessageEnvelope(value: unknown): { readonly message: Message } {
  validateMessage(record(value, "Model response").message);
  return value as { readonly message: Message };
}

function validateModelEvent(value: unknown): ModelEvent {
  const data = record(value, "Model event");
  if (data.type === "text.delta" || data.type === "reasoning.delta") {
    if (typeof data.delta !== "string") throw new TypeError("Model delta must be a string");
  } else if (data.type === "response.completed") {
    if (validateMessage(data.message).role !== "assistant")
      throw new TypeError("Model response requires assistant message");
  } else if (data.type === "server_tool.updated") {
    validateServerToolCall(data.call);
  } else if (data.type === "retrying") {
    for (const name of ["attempt", "maxAttempts", "delayMs"]) {
      if (!Number.isSafeInteger(data[name]) || (data[name] as number) < 0) throw new TypeError(`Invalid ${name}`);
    }
    validateFailure({ error: data.error });
  } else throw new TypeError("Invalid model event type");
  return value as ModelEvent;
}

function validateFailure(value: unknown): HookFailure {
  const error = record(record(value, "Hook failure").error, "Serialized error");
  nonEmpty(error.name, "Error name");
  if (typeof error.message !== "string") throw new TypeError("Error message must be a string");
  optionalString(error.code, "Error code");
  return value as HookFailure;
}

function validateToolFailure(value: unknown): ToolFailureHook {
  validateFailure(value);
  validateCall(record(value, "Tool failure").call);
  return value as ToolFailureHook;
}

function validateCall(value: unknown): asserts value is ToolCall {
  const call = record(value, "Tool call");
  nonEmpty(call.id, "Tool call id");
  nonEmpty(call.name, "Tool call name");
  if (!("input" in call)) throw new TypeError("Tool call requires input");
  optionalString(call.rawInput, "Tool call rawInput");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "string") throw new TypeError(`${name} must be a string`);
}

function nonEmpty(value: unknown, name: string): void {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
}
