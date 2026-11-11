import type {
  AssistantMessage,
  ContentPart,
  MayEvent,
  ServerToolCall,
  ToolCall,
  UserMessage,
} from "@sortedyuan/may/core";
import { omitUndefined } from "@sortedyuan/may/core";
import type { ApprovalDecision, ApprovalRequest, PermissionEvent } from "@sortedyuan/may/permissions";
import {
  isSessionRunTerminalEvent,
  SessionTranscriptReader,
  sessionToolFailureStatus,
  type SessionEvent,
  type SessionToolStatus,
  type SessionToolPresentation,
  type SessionTranscriptEntry,
} from "@sortedyuan/may/session";
import { createCodingToolPresentationProjector } from "./tool-renderers.js";

/** @experimental */
export type TranscriptItem =
  UserTranscriptItem | AssistantTranscriptItem | ToolTranscriptItem | ApprovalTranscriptItem | NoticeTranscriptItem;

/** @experimental */
export interface UserTranscriptItem {
  readonly id: string;
  readonly kind: "user";
  readonly text: string;
  readonly timestamp: number;
}

/** @experimental */
export interface AssistantTranscriptItem {
  readonly content?: readonly ContentPart[];
  readonly id: string;
  readonly kind: "assistant";
  readonly runId: string;
  readonly step: number;
  readonly text: string;
  readonly reasoning: string;
  readonly status: "streaming" | "completed" | "interrupted";
  readonly timestamp: number;
}

/** @experimental */
export interface ToolTranscriptItem {
  readonly content?: readonly ContentPart[];
  readonly id: string;
  readonly kind: "tool";
  readonly runId: string;
  readonly step: number;
  readonly call: ToolCall;
  readonly status: SessionToolStatus;
  readonly streamedOutput: string;
  readonly progress: readonly string[];
  readonly output?: unknown;
  readonly error?: string;
  /** Value produced by the store's `ToolPresentationProjector`; tool renderers interpret it. */
  readonly presentation?: unknown;
  readonly timestamp: number;
}

/**
 * Display data for one tool call, decoded from application-owned presentation metadata.
 * @experimental
 */
export interface ToolPresentationProjection {
  /** Names the tool call when the presentation arrives before the call itself. */
  readonly toolName: string;
  readonly input: unknown;
  readonly value: unknown;
}

/**
 * Decodes saved or live tool presentation metadata. Returning `undefined` leaves the transcript unchanged.
 * @experimental
 */
export type ToolPresentationProjector = (
  presentation: SessionToolPresentation,
) => ToolPresentationProjection | undefined;

/** @experimental */
export interface TranscriptStoreOptions {
  /** Defaults to the projector for the standard May coding tools. */
  readonly toolPresentationProjector?: ToolPresentationProjector;
}

/** @experimental */
export interface ApprovalTranscriptItem {
  readonly id: string;
  readonly kind: "approval";
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly decision?: ApprovalDecision;
  readonly scopeDescription?: string;
  readonly scopeId?: string;
  readonly reason?: string;
  readonly timestamp: number;
}

/** @experimental */
export interface NoticeTranscriptItem {
  readonly id: string;
  readonly kind: "notice";
  readonly level: "info" | "warning" | "error";
  readonly text: string;
  readonly timestamp: number;
}

/** @experimental */
export type TranscriptListener = (store: TranscriptStore) => void;

/**
 * Mutable terminal projection of durable session history and live May events.
 *
 * Product-specific events stay outside this package: applications can reset the
 * projection and append notices or tool presentations through the explicit
 * methods below.
 * @experimental
 */
export class TranscriptStore {
  private readonly toolPresentationProjector: ToolPresentationProjector;
  private values: TranscriptItem[] = [];
  private readonly listeners = new Set<TranscriptListener>();
  private localSequence = 0;
  private currentSessionId: string | undefined;
  private latestReplyId: string | undefined;
  private readonly transcriptReader = new SessionTranscriptReader();
  private readonly approvalTools = new Map<string, string>();
  private readonly cancelledApprovals = new Set<string>();

  constructor(options: TranscriptStoreOptions = {}) {
    this.toolPresentationProjector = options.toolPresentationProjector ?? createCodingToolPresentationProjector();
  }

  /** 当前轮次完成后可供阅读的最终正文。 */
  get latestReply(): AssistantTranscriptItem | undefined {
    const item = this.values.find((item) => item.id === this.latestReplyId);
    return item?.kind === "assistant" &&
      (item.text.trim() !== "" || item.content?.some((part) => part.type === "image"))
      ? item
      : undefined;
  }

  get items(): readonly TranscriptItem[] {
    return this.values;
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  subscribe(listener: TranscriptListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(sessionId?: string): void {
    this.values = [];
    this.latestReplyId = undefined;
    this.transcriptReader.reset();
    this.approvalTools.clear();
    this.cancelledApprovals.clear();
    this.currentSessionId = sessionId;
    this.changed();
  }

  appendUser(message: string | UserMessage, timestamp = Date.now()): void {
    this.latestReplyId = undefined;
    const text = typeof message === "string" ? message : contentText(message.content, "text");
    this.append({
      id: `user:local:${++this.localSequence}`,
      kind: "user",
      text,
      timestamp,
    });
    this.changed();
  }

  appendNotice(level: NoticeTranscriptItem["level"], text: string, timestamp = Date.now()): void {
    this.appendNoticeItem(`notice:local:${++this.localSequence}`, level, text, timestamp);
    this.changed();
  }

  /** Attach application-produced display data to a tool call. */
  attachToolPresentation(
    runId: string,
    step: number,
    toolCallId: string,
    projection: ToolPresentationProjection,
    timestamp = Date.now(),
  ): void {
    this.projectToolPresentationValue(runId, step, toolCallId, projection, timestamp);
    this.changed();
  }

  appendToolPresentation(presentation: SessionToolPresentation, timestamp = Date.now()): void {
    this.projectToolPresentation(presentation, timestamp);
    this.changed();
  }

  loadHistory(events: readonly SessionEvent[]): void {
    this.values = [];
    this.latestReplyId = undefined;
    this.transcriptReader.reset();
    this.approvalTools.clear();
    this.cancelledApprovals.clear();
    this.currentSessionId = events[0]?.sessionId ?? this.currentSessionId;
    for (const event of events) this.projectSessionEvent(event);
    this.changed();
  }

  applyMayEvent(event: MayEvent): void {
    this.projectMayEvent(event);
    this.changed();
  }

  applyPermissionEvent(event: PermissionEvent): void {
    this.projectPermissionEvent(event);
    this.changed();
  }

  applySessionEvent(event: SessionEvent): void {
    this.currentSessionId = event.sessionId;
    this.projectSessionEvent(event);
    this.changed();
  }

  private projectMayEvent(event: MayEvent): void {
    switch (event.type) {
      case "run.started":
        this.latestReplyId = undefined;
        break;
      case "input.received":
        this.appendSteering(event.runId, event.step, event.messages, event.timestamp);
        break;
      case "run.completed":
        this.completeReply(event);
        break;
      case "model.started":
        this.ensureAssistant(event);
        break;
      case "model.text.delta":
        this.updateAssistant(event, (item) => ({ ...item, text: item.text + event.delta }));
        break;
      case "model.reasoning.delta":
        this.updateAssistant(event, (item) => ({
          ...item,
          reasoning: item.reasoning + event.delta,
        }));
        break;
      case "model.server_tool.updated":
        this.projectServerTool(event.call, event.timestamp);
        break;
      case "model.completed": {
        for (const call of event.message.serverToolCalls ?? []) this.projectServerTool(call, event.timestamp);
        const completed = assistantContent(event.message);
        this.updateAssistant(event, (item) => ({
          ...item,
          text: completed.text || item.text,
          content: completed.content,
          reasoning: completed.reasoning || item.reasoning,
          status: "completed",
        }));
        break;
      }
      case "model.retrying":
        this.appendNoticeItem(
          `retry:${event.runId}:${event.seq}`,
          "warning",
          `Model request failed: ${event.error.message}; retrying ` + `${event.attempt}/${event.maxAttempts}`,
          event.timestamp,
        );
        break;
      case "tool.started":
        this.ensureTool(event.runId, event.step, event.call, event.timestamp);
        break;
      case "tool.output.delta":
        this.updateTool(
          event.runId,
          event.call.id,
          (item) => ({
            ...item,
            streamedOutput: (item.streamedOutput + event.delta).slice(-65_536).replace(/^[\uDC00-\uDFFF]/u, ""),
          }),
          event.step,
          event.call,
          event.timestamp,
        );
        break;
      case "tool.progress":
        this.updateTool(
          event.runId,
          event.call.id,
          (item) => ({
            ...item,
            progress: [...item.progress.slice(-63), event.message.slice(0, 4096)],
          }),
          event.step,
          event.call,
          event.timestamp,
        );
        break;
      case "tool.completed":
        this.updateTool(
          event.runId,
          event.call.id,
          (item) => ({
            ...item,
            status: "completed",
            output: event.output,
            content: event.content,
          }),
          event.step,
          event.call,
          event.timestamp,
        );
        break;
      case "tool.failed":
        this.updateTool(
          event.runId,
          event.call.id,
          (item) => ({
            ...item,
            status: sessionToolFailureStatus(event.error, this.cancelledApprovals.has(item.id)),
            error: event.error.message,
          }),
          event.step,
          event.call,
          event.timestamp,
        );
        this.cancelledApprovals.delete(toolId(event.runId, event.call.id));
        break;
      case "run.failed":
        this.appendNoticeItem(
          `run:${event.runId}:failed`,
          "error",
          `Run failed: ${event.error.message}`,
          event.timestamp,
        );
        break;
      case "run.cancelled":
        this.appendNoticeItem(
          `run:${event.runId}:cancelled`,
          "warning",
          `Run cancelled${event.reason === undefined ? "" : `: ${event.reason}`}`,
          event.timestamp,
        );
        break;
      case "step.started":
      case "step.completed":
      case "run.yielded":
      case "input.generated":
      case "run.budget.exceeded":
        break;
    }
    if (isSessionRunTerminalEvent(event)) this.settle(event.runId);
  }

  private projectPermissionEvent(event: PermissionEvent): void {
    if (event.type === "approval.requested") {
      this.approvalTools.set(event.request.id, toolId(event.request.context.runId, event.request.context.toolCallId));
      this.append(approvalItem(event.request, event.timestamp));
      return;
    }
    if (event.type !== "approval.resolved" && event.type !== "approval.cancelled") return;
    this.settleApproval(event);
    this.replace(`approval:${event.requestId}`, (item) => {
      if (item.kind !== "approval") return item;
      return event.type === "approval.resolved"
        ? { ...item, status: "resolved", decision: event.decision }
        : { ...item, status: "cancelled", ...omitUndefined({ reason: event.reason }) };
    });
  }

  private projectToolPresentationValue(
    runId: string,
    step: number,
    toolCallId: string,
    projection: ToolPresentationProjection,
    timestamp: number,
  ): void {
    this.ensureTool(runId, step, { id: toolCallId, name: projection.toolName, input: projection.input }, timestamp);
    this.replace(toolId(runId, toolCallId), (item) =>
      item.kind === "tool" ? { ...item, presentation: projection.value } : item,
    );
  }

  private projectSessionEvent(event: SessionEvent): void {
    for (const entry of this.transcriptReader.read(event)) {
      if (entry.type === "user-message") {
        this.latestReplyId = undefined;
        this.append({
          id: entry.source === "steering" ? entry.id : `history:${entry.seq}`,
          kind: "user",
          text: contentText(entry.message.content, "text"),
          timestamp: entry.timestamp,
        });
      } else this.projectRecordedEvent(entry.event);
    }
  }

  private projectRecordedEvent(event: Extract<SessionTranscriptEntry, { type: "event" }>["event"]): void {
    switch (event.type) {
      case "run.started":
        this.latestReplyId = undefined;
        break;
      case "run.completed":
        this.completeReply(event);
        break;
      case "run.interrupted":
        this.settle(event.runId);
        for (const item of event.recoveries) {
          this.appendHistoryTool(
            historyTool(
              {
                ...event,
                type: "tool.failed",
                step: item.step,
                call: item.call,
                error: {
                  name: "InterruptedToolError",
                  message:
                    item.status === "unknown"
                      ? "Outcome unknown; inspect /recovery before continuing"
                      : "Not executed before interruption",
                },
              },
              item.status,
            ),
          );
        }
        this.appendNoticeItem(
          `history:${event.seq}`,
          "warning",
          "Run interrupted. Inspect /recovery for unresolved tool outcomes.",
          event.timestamp,
        );
        break;
      case "assistant.completed": {
        for (const call of event.message.serverToolCalls ?? []) this.projectServerTool(call, event.timestamp);
        const content = assistantContent(event.message);
        this.append({
          id: assistantId(event.runId, event.step),
          kind: "assistant",
          runId: event.runId,
          step: event.step,
          text: content.text,
          content: content.content,
          reasoning: content.reasoning,
          status: "completed",
          timestamp: event.timestamp,
        });
        break;
      }
      case "tool.started":
        this.ensureTool(event.runId, event.step, event.call, event.timestamp);
        break;
      case "tool.completed":
        this.appendHistoryTool(historyTool(event, "completed"));
        break;
      case "tool.failed":
        this.appendHistoryTool(
          historyTool(
            event,
            sessionToolFailureStatus(event.error, this.cancelledApprovals.has(toolId(event.runId, event.call.id))),
          ),
        );
        this.cancelledApprovals.delete(toolId(event.runId, event.call.id));
        break;
      case "tool.presentation": {
        this.projectToolPresentation(event, event.timestamp);
        break;
      }
      case "approval.requested":
        this.approvalTools.set(event.request.id, toolId(event.request.runId, event.request.toolCallId));
        this.append({
          id: `approval:${event.request.id}`,
          kind: "approval",
          requestId: event.request.id,
          toolName: event.request.tool.name,
          input: event.request.input,
          ...(event.request.persistent === undefined
            ? {}
            : { scopeDescription: event.request.persistent.description, scopeId: event.request.persistent.scopeId }),
          status: "pending",
          timestamp: event.timestamp,
        });
        break;
      case "approval.resolved":
      case "approval.cancelled":
        this.applyHistoryApproval(event);
        break;
      case "context.compacted":
        this.appendNoticeItem(
          `history:${event.seq}`,
          "info",
          `Context compacted with ${event.strategy}: ` +
            `${event.beforeMessageCount} → ${event.afterMessageCount} messages`,
          event.timestamp,
        );
        break;
      case "run.failed":
        this.appendNoticeItem(`history:${event.seq}`, "error", `Run failed: ${event.error.message}`, event.timestamp);
        break;
      case "run.cancelled":
        this.appendNoticeItem(
          `history:${event.seq}`,
          "warning",
          `Run cancelled${event.reason === undefined ? "" : `: ${event.reason}`}`,
          event.timestamp,
        );
        break;
      case "session.created":
      case "run.yielded":
      case "continuation.submitted":
      case "history.omitted":
      case "input.generated":
      case "model.attempt.completed":
      case "model.attempt.failed":
      case "model.attempt.started":
      case "model.request.defined":
      case "model.request.prepared":
      case "rule.created":
      case "rule.revoked":
      case "rule.used":
      case "run.budget.exceeded":
      case "run.settled":
      case "runtime.changed":
      case "runtime.state.saved":
      case "session.fork.ready":
      case "state.updated":
        break;
    }
    if (isSessionRunTerminalEvent(event) && "runId" in event) this.settle(event.runId);
  }

  private settle(runId: string): void {
    this.values = this.values.flatMap((item) => {
      if ((item.kind !== "tool" && item.kind !== "assistant") || item.runId !== runId) return [item];
      if (item.kind === "tool") return [item.status === "running" ? { ...item, status: "unknown" as const } : item];
      if (item.status !== "streaming") return [item];
      return item.text === "" && item.reasoning === "" ? [] : [{ ...item, status: "interrupted" as const }];
    });
  }

  private settleApproval(event: { type: "approval.resolved" | "approval.cancelled"; requestId: string }): void {
    const id = this.approvalTools.get(event.requestId);
    if (id !== undefined && event.type === "approval.cancelled") this.cancelledApprovals.add(id);
    this.approvalTools.delete(event.requestId);
  }

  private applyHistoryApproval(
    event: Extract<SessionEvent, { type: "approval.resolved" | "approval.cancelled" }>,
  ): void {
    this.settleApproval(event);
    this.replace(`approval:${event.requestId}`, (item) => {
      if (item.kind !== "approval") return item;
      return event.type === "approval.resolved"
        ? { ...item, status: "resolved", decision: event.decision }
        : { ...item, status: "cancelled", ...omitUndefined({ reason: event.reason }) };
    });
  }

  private appendSteering(runId: string, step: number, messages: readonly UserMessage[], timestamp: number): void {
    this.latestReplyId = undefined;
    for (const [index, message] of messages.entries()) {
      this.append({
        id: `steering:${runId}:${step}:${index}`,
        kind: "user",
        text: contentText(message.content, "text"),
        timestamp,
      });
    }
  }

  private completeReply(event: Extract<MayEvent | SessionEvent, { type: "run.completed" }>): void {
    const step = event.result.steps;
    const content = assistantContent(event.result.message);
    this.updateAssistant({ ...event, step }, (item) => ({
      ...item,
      text: content.text || item.text,
      content: content.content,
      reasoning: content.reasoning || item.reasoning,
      status: "completed",
    }));
    this.latestReplyId = assistantId(event.runId, step);
  }

  private ensureAssistant(event: { runId: string; step: number; timestamp: number }): void {
    const id = assistantId(event.runId, event.step);
    if (this.values.some((item) => item.id === id)) return;
    this.append({
      id,
      kind: "assistant",
      runId: event.runId,
      step: event.step,
      text: "",
      reasoning: "",
      status: "streaming",
      timestamp: event.timestamp,
    });
  }

  private updateAssistant(
    event: { runId: string; step: number; timestamp: number },
    update: (item: AssistantTranscriptItem) => AssistantTranscriptItem,
  ): void {
    this.ensureAssistant(event);
    this.replace(assistantId(event.runId, event.step), (item) => (item.kind === "assistant" ? update(item) : item));
  }

  private ensureTool(runId: string, step: number, call: ToolCall, timestamp: number): void {
    const id = toolId(runId, call.id);
    if (this.values.some((item) => item.id === id)) return;
    this.append({
      id,
      kind: "tool",
      runId,
      step,
      call,
      status: "running",
      streamedOutput: "",
      progress: [],
      timestamp,
    });
  }

  private updateTool(
    runId: string,
    callId: string,
    update: (item: ToolTranscriptItem) => ToolTranscriptItem,
    step: number,
    call: ToolCall,
    timestamp: number,
  ): void {
    this.ensureTool(runId, step, call, timestamp);
    this.replace(toolId(runId, callId), (item) => (item.kind === "tool" ? update(item) : item));
  }

  private appendNoticeItem(id: string, level: NoticeTranscriptItem["level"], text: string, timestamp: number): void {
    this.append({ id, kind: "notice", level, text, timestamp });
  }

  private projectServerTool(call: ServerToolCall, timestamp: number): void {
    const sources = (call.sources ?? []).map((source) => `${source.title ?? source.url} · ${source.url}`);
    const text = [
      `${call.name}: ${call.status}`,
      ...(call.input === undefined ? [] : [JSON.stringify(call.input)]),
      ...sources,
      ...(call.error ? [call.error.code] : []),
    ].join("\n");
    this.appendNoticeItem(`server-tool:${call.id}`, call.status === "failed" ? "error" : "info", text, timestamp);
  }

  private projectToolPresentation(event: SessionToolPresentation, timestamp: number): void {
    const projection = this.toolPresentationProjector(event);
    if (projection) this.projectToolPresentationValue(event.runId, event.step, event.toolCallId, projection, timestamp);
  }

  private appendHistoryTool(item: ToolTranscriptItem): void {
    const existing = this.values.find((value) => value.id === item.id);
    this.append(
      existing?.kind === "tool" && existing.presentation !== undefined
        ? { ...item, presentation: existing.presentation }
        : item,
    );
  }

  private append(item: TranscriptItem): void {
    const index = this.values.findIndex((value) => value.id === item.id);
    if (index >= 0) this.values[index] = item;
    else this.values.push(item);
  }

  private replace(id: string, update: (item: TranscriptItem) => TranscriptItem): boolean {
    const index = this.values.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.values[index] = update(this.values[index]!);
    return true;
  }

  private changed(): void {
    for (const listener of this.listeners) listener(this);
  }
}

function approvalItem(request: ApprovalRequest, timestamp: number): ApprovalTranscriptItem {
  return {
    id: `approval:${request.id}`,
    kind: "approval",
    requestId: request.id,
    toolName: request.tool.name,
    input: request.input,
    ...(request.persistent === undefined
      ? {}
      : { scopeDescription: request.persistent.description, scopeId: request.persistent.scopeId }),
    status: "pending",
    timestamp,
  };
}

function historyTool(
  event: Extract<SessionEvent, { type: "tool.completed" | "tool.failed" }>,
  status: SessionToolStatus,
): ToolTranscriptItem {
  return {
    id: toolId(event.runId, event.call.id),
    kind: "tool",
    runId: event.runId,
    step: event.step,
    call: event.call,
    status,
    streamedOutput: "",
    progress: [],
    ...(event.type === "tool.completed"
      ? { output: event.output, ...(event.content ? { content: event.content } : {}) }
      : { error: event.error.message }),
    timestamp: event.timestamp,
  };
}

function assistantContent(message: AssistantMessage): {
  readonly content: readonly ContentPart[];
  readonly text: string;
  readonly reasoning: string;
} {
  return {
    content: message.content,
    text: contentText(message.content, "text") + searchSources(message),
    reasoning: contentText(message.content, "reasoning"),
  };
}

function searchSources(message: AssistantMessage): string {
  const sources = new Map<string, string>();
  for (const part of message.content)
    if (part.type === "text")
      for (const citation of part.citations ?? []) sources.set(citation.url, citation.title ?? citation.url);
  for (const call of message.serverToolCalls ?? [])
    for (const source of call.sources ?? []) sources.set(source.url, source.title ?? source.url);
  return sources.size ? `\n\nSources:\n${[...sources].map(([url, title]) => `${title} · ${url}`).join("\n")}` : "";
}

function contentText(content: readonly ContentPart[], type: "text" | "reasoning"): string {
  return content.flatMap((part) => (part.type === type ? [part.text] : [])).join("");
}

function assistantId(runId: string, step: number): string {
  return `assistant:${runId}:${step}`;
}

function toolId(runId: string, callId: string): string {
  return `tool:${runId}:${callId}`;
}
