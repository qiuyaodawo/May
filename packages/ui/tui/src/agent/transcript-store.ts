import type {
  AssistantMessage,
  ContentPart,
  MayEvent,
  ToolCall,
  UserMessage,
} from "@may/core";
import type {
  ApprovalDecision,
  ApprovalRequest,
  PermissionEvent,
} from "@may/permissions";
import type { SessionEvent } from "@may/session";
import {
  decodeToolChangePreviewPresentation,
  type ToolChangePreview,
} from "@may/coding-tools/change-preview";

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | ApprovalTranscriptItem
  | NoticeTranscriptItem;

export interface UserTranscriptItem {
  readonly id: string;
  readonly kind: "user";
  readonly text: string;
  readonly timestamp: number;
}

export interface AssistantTranscriptItem {
  readonly id: string;
  readonly kind: "assistant";
  readonly runId: string;
  readonly step: number;
  readonly text: string;
  readonly reasoning: string;
  readonly status: "streaming" | "completed";
  readonly timestamp: number;
}

export interface ToolTranscriptItem {
  readonly id: string;
  readonly kind: "tool";
  readonly runId: string;
  readonly step: number;
  readonly call: ToolCall;
  readonly status: "running" | "completed" | "failed";
  readonly streamedOutput: string;
  readonly progress: readonly string[];
  readonly output?: unknown;
  readonly error?: string;
  readonly preview?: ToolChangePreview;
  readonly timestamp: number;
}

export interface ApprovalTranscriptItem {
  readonly id: string;
  readonly kind: "approval";
  readonly requestId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly decision?: ApprovalDecision;
  readonly reason?: string;
  readonly timestamp: number;
}

export interface NoticeTranscriptItem {
  readonly id: string;
  readonly kind: "notice";
  readonly level: "info" | "warning" | "error";
  readonly text: string;
  readonly timestamp: number;
}

export type TranscriptListener = (store: TranscriptStore) => void;

/**
 * Mutable terminal projection of durable session history and live May events.
 *
 * Product-specific events stay outside this package: applications can reset the
 * projection and append notices or coding change previews through the explicit
 * methods below.
 */
export class TranscriptStore {
  private values: TranscriptItem[] = [];
  private readonly listeners = new Set<TranscriptListener>();
  private localSequence = 0;
  private currentSessionId: string | undefined;

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
    this.currentSessionId = sessionId;
    this.changed();
  }

  appendUser(message: string | UserMessage, timestamp = Date.now()): void {
    const text = typeof message === "string"
      ? message
      : contentText(message.content, "text");
    this.append({
      id: `user:local:${++this.localSequence}`,
      kind: "user",
      text,
      timestamp,
    });
    this.changed();
  }

  appendNotice(
    level: NoticeTranscriptItem["level"],
    text: string,
    timestamp = Date.now(),
  ): void {
    this.appendNoticeItem(
      `notice:local:${++this.localSequence}`,
      level,
      text,
      timestamp,
    );
    this.changed();
  }

  /** Attach an application-produced coding change preview to a tool call. */
  appendChangePreview(
    runId: string,
    step: number,
    toolCallId: string,
    preview: ToolChangePreview,
    timestamp = Date.now(),
  ): void {
    this.projectChangePreview(runId, step, toolCallId, preview, timestamp);
    this.changed();
  }

  loadHistory(events: readonly SessionEvent[]): void {
    this.values = [];
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
      case "model.completed": {
        const completed = assistantContent(event.message);
        this.updateAssistant(event, (item) => ({
          ...item,
          text: completed.text || item.text,
          reasoning: completed.reasoning || item.reasoning,
          status: "completed",
        }));
        break;
      }
      case "model.retrying":
        this.appendNoticeItem(
          `retry:${event.runId}:${event.seq}`,
          "warning",
          `Model request failed: ${event.error.message}; retrying ` +
            `${event.attempt}/${event.maxAttempts}`,
          event.timestamp,
        );
        break;
      case "tool.started":
        this.ensureTool(event.runId, event.step, event.call, event.timestamp);
        break;
      case "tool.output.delta":
        this.updateTool(event.runId, event.call.id, (item) => ({
          ...item,
          streamedOutput: item.streamedOutput + event.delta,
        }), event.step, event.call, event.timestamp);
        break;
      case "tool.progress":
        this.updateTool(event.runId, event.call.id, (item) => ({
          ...item,
          progress: [...item.progress, event.message],
        }), event.step, event.call, event.timestamp);
        break;
      case "tool.completed":
        this.updateTool(event.runId, event.call.id, (item) => ({
          ...item,
          status: "completed",
          output: event.output,
        }), event.step, event.call, event.timestamp);
        break;
      case "tool.failed":
        this.updateTool(event.runId, event.call.id, (item) => ({
          ...item,
          status: "failed",
          error: event.error.message,
        }), event.step, event.call, event.timestamp);
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
      case "run.started":
      case "step.started":
      case "step.completed":
      case "run.completed":
        break;
    }
  }

  private projectPermissionEvent(event: PermissionEvent): void {
    if (event.type === "approval.requested") {
      this.append(approvalItem(event.request, event.timestamp));
      return;
    }
    this.replace(`approval:${event.requestId}`, (item) => {
      if (item.kind !== "approval") return item;
      return event.type === "approval.resolved"
        ? { ...item, status: "resolved", decision: event.decision }
        : {
            ...item,
            status: "cancelled",
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          };
    });
  }

  private projectChangePreview(
    runId: string,
    step: number,
    toolCallId: string,
    preview: ToolChangePreview,
    timestamp: number,
  ): void {
    const id = toolId(runId, toolCallId);
    if (!this.replace(id, (item) => item.kind === "tool" ? { ...item, preview } : item)) {
      this.append({
        id,
        kind: "tool",
        runId,
        step,
        call: { id: toolCallId, name: preview.tool, input: { path: preview.path } },
        status: "running",
        streamedOutput: "",
        progress: [],
        preview,
        timestamp,
      });
    }
  }

  private projectSessionEvent(event: SessionEvent): void {
    switch (event.type) {
      case "run.interrupted":
        for (const item of event.recoveries) {
          this.appendHistoryTool(historyTool({ ...event, type: "tool.failed", step: item.step, call: item.call,
            error: { name: "InterruptedToolError", message: item.status === "unknown" ? "Outcome unknown; inspect /recovery before continuing" : "Not executed before interruption" } }, "failed"));
        }
        this.appendNoticeItem(`history:${event.seq}`, "warning", "Run interrupted. Inspect /recovery for unresolved tool outcomes.", event.timestamp);
        break;
      case "recovery.resolved":
      case "input.submitted":
        this.append({
          id: `history:${event.seq}`,
          kind: "user",
          text: contentText(event.message.content, "text"),
          timestamp: event.timestamp,
        });
        break;
      case "assistant.completed": {
        const content = assistantContent(event.message);
        this.append({
          id: assistantId(event.runId, event.step),
          kind: "assistant",
          runId: event.runId,
          step: event.step,
          text: content.text,
          reasoning: content.reasoning,
          status: "completed",
          timestamp: event.timestamp,
        });
        break;
      }
      case "tool.completed":
        this.appendHistoryTool(historyTool(event, "completed"));
        break;
      case "tool.failed":
        this.appendHistoryTool(historyTool(event, "failed"));
        break;
      case "tool.presentation": {
        const preview = decodeToolChangePreviewPresentation(
          event.kind,
          event.version,
          event.data,
        );
        if (preview !== undefined) {
          this.projectChangePreview(
            event.runId,
            event.step,
            event.toolCallId,
            preview,
            event.timestamp,
          );
        }
        break;
      }
      case "approval.requested":
        this.append({
          id: `approval:${event.request.id}`,
          kind: "approval",
          requestId: event.request.id,
          toolName: event.request.tool.name,
          input: event.request.input,
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
        this.appendNoticeItem(
          `history:${event.seq}`,
          "error",
          `Run failed: ${event.error.message}`,
          event.timestamp,
        );
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
      case "run.started":
      case "run.completed":
        break;
    }
  }

  private applyHistoryApproval(
    event: Extract<SessionEvent, { type: "approval.resolved" | "approval.cancelled" }>,
  ): void {
    this.replace(`approval:${event.requestId}`, (item) => {
      if (item.kind !== "approval") return item;
      return event.type === "approval.resolved"
        ? { ...item, status: "resolved", decision: event.decision }
        : {
            ...item,
            status: "cancelled",
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          };
    });
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
    this.replace(assistantId(event.runId, event.step), (item) =>
      item.kind === "assistant" ? update(item) : item
    );
  }

  private ensureTool(
    runId: string,
    step: number,
    call: ToolCall,
    timestamp: number,
  ): void {
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
    this.replace(toolId(runId, callId), (item) =>
      item.kind === "tool" ? update(item) : item
    );
  }

  private appendNoticeItem(
    id: string,
    level: NoticeTranscriptItem["level"],
    text: string,
    timestamp: number,
  ): void {
    this.append({ id, kind: "notice", level, text, timestamp });
  }

  private appendHistoryTool(item: ToolTranscriptItem): void {
    const existing = this.values.find((value) => value.id === item.id);
    this.append(
      existing?.kind === "tool" && existing.preview !== undefined
        ? { ...item, preview: existing.preview }
        : item,
    );
  }

  private append(item: TranscriptItem): void {
    const index = this.values.findIndex((value) => value.id === item.id);
    if (index >= 0) this.values[index] = item;
    else this.values.push(item);
  }

  private replace(
    id: string,
    update: (item: TranscriptItem) => TranscriptItem,
  ): boolean {
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
    status: "pending",
    timestamp,
  };
}

function historyTool(
  event: Extract<SessionEvent, { type: "tool.completed" | "tool.failed" }>,
  status: "completed" | "failed",
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
      ? { output: event.output }
      : { error: event.error.message }),
    timestamp: event.timestamp,
  };
}

function assistantContent(message: AssistantMessage): {
  readonly text: string;
  readonly reasoning: string;
} {
  return {
    text: contentText(message.content, "text"),
    reasoning: contentText(message.content, "reasoning"),
  };
}

function contentText(
  content: readonly ContentPart[],
  type: "text" | "reasoning",
): string {
  return content.flatMap((part) => part.type === type ? [part.text] : []).join("");
}

function assistantId(runId: string, step: number): string {
  return `assistant:${runId}:${step}`;
}

function toolId(runId: string, callId: string): string {
  return `tool:${runId}:${callId}`;
}
