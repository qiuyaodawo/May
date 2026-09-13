import type { ContentPart, MayEvent } from "@may/core";
import type { AgentApplicationEvent } from "@may/application";
import type { SessionEvent } from "@may/session";
import type { UiBlock, UiInteraction } from "./protocol.js";

const LIMIT = 65_536;
function bounded(text: string): string { return text.length > LIMIT ? text.slice(0, LIMIT) + "\n…显示已截断，请在宿主中查看完整内容。" : text; }
export function displayValue(value: unknown): string {
  try { return bounded(typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""); }
  catch { return "[无法显示的数据]"; }
}
export function contentText(content: readonly ContentPart[], kind = "text"): string {
  return bounded(content.map(part => part.type === kind && "text" in part ? part.text : kind === "text" && part.type !== "reasoning" && part.type !== "text" ? `[${part.type} 内容]` : "").join(""));
}

/** UI-neutral, bounded projection; never imports a terminal renderer or provider state. */
export class UiProjection {
  readonly blocks = new Map<string, UiBlock>();
  readonly interactions = new Map<string, UiInteraction>();
  private set(block: UiBlock): void {
    this.blocks.set(block.id, block);
    while (this.blocks.size > 500) this.blocks.delete(this.blocks.keys().next().value!);
  }
  history(events: readonly SessionEvent[]): void {
    for (const event of events) {
      if (event.type === "input.submitted") this.set({ id: `input:${event.seq}`, kind: "user", text: contentText(event.message.content) });
      else if (event.type === "assistant.completed") this.assistantCompleted(`assistant:${event.runId}:${event.step}`, event.message.content);
      else if (event.type === "tool.presentation") this.presentation(event);
      else if (event.type.startsWith("approval.")) this.permission(event as Extract<SessionEvent, { type: "approval.requested" | "approval.resolved" | "approval.cancelled" }>);
      else if (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed" || event.type === "run.failed" || event.type === "run.cancelled") this.run(event);
    }
  }
  event(event: AgentApplicationEvent): void {
    if (event.type === "run.event") this.run(event.event);
    else if (event.type === "permission.event") this.permission(event.event);
    else if (event.type === "tool.presentation") this.presentation(event.presentation);
  }
  private assistantCompleted(id: string, content: readonly ContentPart[]): void {
    const text = contentText(content), reasoning = contentText(content, "reasoning");
    // A tool-call-only response has its own tool card, not an empty assistant bubble.
    if (!text && !reasoning) this.blocks.delete(id);
    else this.set({ id, kind: "assistant", text, reasoning, status: "completed" });
  }
  private permission(event: { type: string; request?: { id: string; tool: { name: string }; input: unknown }; requestId?: string }): void {
    if (event.type === "approval.requested" && event.request) {
      const detail = displayValue(event.request.input);
      this.interactions.set(event.request.id, { id: event.request.id, kind: "approval", title: `允许执行 ${event.request.tool.name}？`, detail, choices: detail.length > LIMIT ? [{ value: "deny", label: "输入过长，拒绝此操作" }] : [
        { value: "deny", label: "拒绝" }, { value: "allow", label: "仅允许这次" }, { value: "allow-session", label: "本会话允许" },
      ] });
    } else if (event.requestId) this.interactions.delete(event.requestId);
  }
  private presentation(event: { runId: string; toolCallId: string; kind: string; version: number; data: unknown }): void {
    const id = `tool:${event.runId}:${event.toolCallId}`;
    const previous = this.blocks.get(id);
    this.set({ id, kind: "tool", text: "", ...previous, presentation: { kind: event.kind, version: event.version, text: displayValue(event.data) } });
  }
  private run(event: MayEvent | Extract<SessionEvent, { type: "tool.started" | "tool.completed" | "tool.failed" | "run.failed" | "run.cancelled" }>): void {
    if ("step" in event && event.type.startsWith("model.")) {
      const id = `assistant:${event.runId}:${event.step}`;
      const previous = this.blocks.get(id) ?? { id, kind: "assistant" as const, text: "", status: "streaming" };
      if (event.type === "model.text.delta") this.set({ ...previous, text: (previous.text + event.delta).slice(0, LIMIT) });
      else if (event.type === "model.reasoning.delta") this.set({ ...previous, reasoning: ((previous.reasoning ?? "") + event.delta).slice(0, LIMIT) });
      else if (event.type === "model.completed") this.assistantCompleted(id, event.message.content);
      else if (event.type === "model.started") this.set(previous);
    }
    if ("call" in event) {
      const id = `tool:${event.runId}:${event.call.id}`;
      const previous = this.blocks.get(id);
      const text = event.type === "tool.completed" ? displayValue(event.output) : event.type === "tool.failed" ? displayValue(event.error.message) : event.type === "tool.output.delta" ? ((previous?.text ?? "") + event.delta).slice(-LIMIT) : previous?.text ?? "";
      this.set({ ...previous, id, kind: "tool", title: event.call.name, input: displayValue(event.call.input), text,
        status: event.type === "tool.completed" ? "completed" : event.type === "tool.failed" ? "failed" : "running" });
    }
    if (event.type === "run.failed" || event.type === "run.cancelled") this.set({ id: `run:${event.runId}`, kind: "notice", text: displayValue(event.type === "run.failed" ? event.error.message : event.reason ?? "运行已取消。"), status: event.type === "run.failed" ? "failed" : "cancelled" });
    if (["run.completed", "run.failed", "run.cancelled", "run.yielded"].includes(event.type)) {
      for (const [id, block] of this.blocks) if (id.includes(`:${event.runId}:`) && ["streaming", "running"].includes(block.status ?? "")) {
        if (block.kind === "assistant" && !block.text && !block.reasoning) this.blocks.delete(id);
        else this.set({ ...block, status: "interrupted" });
      }
    }
  }
}
