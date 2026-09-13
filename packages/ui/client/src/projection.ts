import type { ContentPart, MayEvent, SerializedError } from "@may/core";
import type { AgentApplicationEvent } from "@may/application";
import type { PermissionEvent } from "@may/permissions";
import type { SessionEvent } from "@may/session";
import type { UiBlock, UiBlockStatus, UiDiagnostic, UiInteraction } from "./protocol.js";

const LIMIT = 65_536;
function bounded(text: string): string { return text.length > LIMIT ? text.slice(0, LIMIT) + "\n…显示已截断，请在宿主中查看完整内容。" : text; }
export function displayValue(value: unknown): string {
  try { return bounded(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""); }
  catch { return "[无法显示的数据]"; }
}
export function contentText(content: readonly ContentPart[], kind = "text"): string {
  return bounded(content.map(part => part.type === kind && "text" in part ? part.text : kind === "text" && part.type !== "reasoning" && part.type !== "text" ? `[${part.type} 内容]` : "").join(""));
}
function diagnostic(error: SerializedError): UiDiagnostic {
  return { message: bounded(error.message), ...(error.code ? { code: error.code.slice(0, 256) } : {}) };
}
const pending = (block: UiBlock) => ["queued", "running", "streaming", "awaiting-approval"].includes(block.status ?? "");
type ApprovalEvent = PermissionEvent | Extract<SessionEvent, { type: "approval.requested" | "approval.resolved" | "approval.cancelled" }>;

/** UI-neutral, bounded projection; never imports a terminal renderer or provider state. */
export class UiProjection {
  readonly blocks = new Map<string, UiBlock>();
  /** Live requests only. Replaying a journal must never manufacture authority. */
  readonly interactions = new Map<string, UiInteraction>();
  private set(block: UiBlock): void {
    this.blocks.set(block.id, block);
    while (this.blocks.size > 500) this.blocks.delete(this.blocks.keys().next().value!);
  }
  history(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.type === "input.submitted") this.set({ id: `input:${event.seq}`, kind: "user", text: contentText(event.message.content) });
      else if (event.type === "assistant.completed") this.assistantCompleted(event.runId, event.step, event.message.content);
      else if (event.type === "tool.presentation") this.presentation(event);
      else if (event.type.startsWith("approval.")) this.permission(event as ApprovalEvent, false);
      else if (event.type === "run.interrupted") {
        this.settle(event.runId);
        for (const recovery of event.recoveries) {
          const id = `tool:${event.runId}:${recovery.call.id}`;
          this.set({ ...this.blocks.get(id), id, kind: "tool", runId: event.runId, toolCallId: recovery.call.id,
            title: recovery.call.name, input: displayValue(recovery.call.input), text: this.blocks.get(id)?.text ?? "", status: recovery.status });
        }
        this.set({ id: `run:${event.runId}`, kind: "notice", runId: event.runId, text: "运行中断；请核对宿主恢复证据。不会自动重跑工具。", status: "interrupted" });
      } else if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed" || event.type === "run.failed" || event.type === "run.cancelled" || event.type === "run.completed" || event.type === "run.yielded") this.run(event);
    }
  }
  event(event: AgentApplicationEvent): void {
    if (event.type === "run.event") this.run(event.event);
    else if (event.type === "permission.event") this.permission(event.event, true);
    else if (event.type === "tool.presentation") this.presentation(event.presentation);
  }
  /** Host says live execution is no longer available; absence of an outcome is not success. */
  settle(runId?: string): void {
    for (const [id, block] of this.blocks) if ((runId === undefined || block.runId === runId) && pending(block)) {
      if (block.kind === "assistant" && !block.text && !block.reasoning) this.blocks.delete(id);
      else this.set({ ...block, status: block.kind === "tool" ? "unknown" : "interrupted" });
    }
    for (const [id, request] of this.interactions) if (runId === undefined || request.runId === runId) this.interactions.delete(id);
  }
  private assistantCompleted(runId: string, step: number, content: readonly ContentPart[]): void {
    const id = `assistant:${runId}:${step}`, text = contentText(content), reasoning = contentText(content, "reasoning");
    if (!text && !reasoning) this.blocks.delete(id);
    else this.set({ id, kind: "assistant", runId, text, reasoning, status: "completed" });
  }
  private permission(event: ApprovalEvent, live: boolean): void {
    if (event.type === "approval.requested") {
      const request = event.request, scope = "context" in request ? request.context : request;
      const id = `tool:${scope.runId}:${scope.toolCallId}`, detail = displayValue(request.input);
      this.set({ ...this.blocks.get(id), id, kind: "tool", runId: scope.runId, toolCallId: scope.toolCallId,
        title: request.tool.name, input: detail, text: this.blocks.get(id)?.text ?? "", status: "awaiting-approval", approval: { id: request.id, status: "pending" } });
      if (live) this.interactions.set(request.id, { id: request.id, kind: "approval", blockId: id, runId: scope.runId, toolCallId: scope.toolCallId, toolName: request.tool.name,
        title: `允许执行 ${request.tool.name}？`, detail, choices: detail.length > LIMIT ? [{ value: "deny", label: "输入过长，拒绝此操作" }] : [
          { value: "deny", label: "拒绝" }, { value: "allow", label: "仅允许这次" },
          ...(request.grantKey === undefined ? [] : [{ value: "allow-session", label: "本会话允许" }]),
        ] });
    } else {
      this.interactions.delete(event.requestId);
      for (const block of this.blocks.values()) if (block.approval?.id === event.requestId) {
        const cancelled = event.type === "approval.cancelled", denied = event.type === "approval.resolved" && event.decision === "deny";
        this.set({ ...block, status: cancelled ? "not-started" : denied ? "denied" : "running",
          approval: { id: event.requestId, status: cancelled ? "cancelled" : denied ? "denied" : "allowed",
            ...(!cancelled && !denied ? { scope: event.decision === "allow-session" ? "session" as const : "once" as const } : {}) } });
        break;
      }
    }
  }
  private presentation(event: { runId: string; toolCallId: string; kind: string; version: number; data: unknown }): void {
    const id = `tool:${event.runId}:${event.toolCallId}`;
    this.set({ id, kind: "tool", runId: event.runId, toolCallId: event.toolCallId, text: "", ...this.blocks.get(id), presentation: { kind: event.kind, version: event.version, text: displayValue(event.data) } });
  }
  private run(event: MayEvent | Extract<SessionEvent, { type: "tool.started" | "tool.completed" | "tool.failed" | "run.failed" | "run.cancelled" | "run.completed" | "run.yielded" }>): void {
    if ("step" in event && event.type.startsWith("model.")) {
      const id = `assistant:${event.runId}:${event.step}`;
      const previous = this.blocks.get(id) ?? { id, kind: "assistant" as const, runId: event.runId, text: "", status: "streaming" as const };
      if (event.type === "model.text.delta") this.set({ ...previous, text: (previous.text + event.delta).slice(0, LIMIT) });
      else if (event.type === "model.reasoning.delta") this.set({ ...previous, reasoning: ((previous.reasoning ?? "") + event.delta).slice(0, LIMIT) });
      else if (event.type === "model.completed") this.assistantCompleted(event.runId, event.step, event.message.content);
      else if (event.type === "model.started") this.set(previous);
    }
    if ("call" in event) {
      const id = `tool:${event.runId}:${event.call.id}`, previous = this.blocks.get(id);
      let status: UiBlockStatus = event.type === "tool.completed" ? "completed" : "running";
      if (event.type === "tool.failed") status = event.error.code === "PERMISSION_DENIED" ? "denied" : event.error.code === "TOOL_SKIPPED" ? "not-started" : event.error.code === "RUN_CANCELLED" ? previous?.approval?.status === "cancelled" ? "not-started" : "unknown" : "failed";
      const text = event.type === "tool.completed" ? displayValue(event.output) : event.type === "tool.output.delta" ? ((previous?.text ?? "") + event.delta).slice(-LIMIT) : previous?.text ?? "";
      this.set({ ...previous, id, kind: "tool", runId: event.runId, toolCallId: event.call.id, title: event.call.name, input: displayValue(event.call.input), text, status,
        ...(event.type === "tool.failed" ? { diagnostic: diagnostic(event.error) } : {}),
        ...(event.type === "tool.progress" ? { progress: bounded(event.message) } : {}) });
    }
    if (event.type === "run.failed" || event.type === "run.cancelled") this.set({ id: `run:${event.runId}`, kind: "notice", runId: event.runId,
      text: event.type === "run.failed" ? "运行失败" : displayValue(event.reason ?? "运行已取消。"),
      ...(event.type === "run.failed" ? { diagnostic: diagnostic(event.error) } : {}), status: event.type === "run.failed" ? "failed" : "cancelled" });
    if (["run.completed", "run.failed", "run.cancelled", "run.yielded"].includes(event.type)) this.settle(event.runId);
  }
}
