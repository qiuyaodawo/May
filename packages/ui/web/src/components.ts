import type { UiBlock, UiInteraction, UiPanel, UiClient, UiClientState, UiDiagnostic } from "@may/ui-client";
import { markdown } from "./markdown.js";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el;
}
export function button(label: string, action: () => void, className = "button"): HTMLButtonElement {
  const el = element("button", className, label); el.type = "button"; el.onclick = action; return el;
}
export function icon(name: "plus" | "menu" | "send" | "stop" | "panel" | "search" | "arrow" | "code" | "task") {
  const paths = { plus: "M12 5v14M5 12h14", menu: "M4 6h16M4 12h16M4 18h16", send: "M12 19V5m-6 6 6-6 6 6", stop: "M6 6h12v12H6z", panel: "M4 4h16v16H4zM14 4v16", search: "m16 16 4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0", arrow: "M7 17 17 7M7 7h10v10", code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16", task: "M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01" };
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.6"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", paths[name]); svg.append(path); return svg;
}
export const statusLabel = (status: string): string => ({ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", blocked: "待处理", idle: "空闲", streaming: "正在生成", interrupted: "已中断", "awaiting-approval": "等待审批", "not-started": "未执行", denied: "已拒绝", unverified: "尚未验证", disabled: "未启用", delivered: "已送达", pending: "待处理", unknown: "结果未知" }[status] ?? status);

/** Trusted host-application extensions, never JavaScript supplied by an agent event.
 * Extensions add content; the shell owns status labels, raw evidence and decision controls.
 */
export type WebUiRenderer<T> = (value: T, context?: WebUiContext) => HTMLElement | null;
export interface WebUiExtensions {
  readonly presentations?: Readonly<Record<string, Readonly<Record<number, WebUiRenderer<UiBlock>>>>>;
  readonly tools?: Readonly<Record<string, WebUiRenderer<UiBlock>>>;
  readonly approvalDetails?: Readonly<Record<string, WebUiRenderer<UiInteraction>>>;
  readonly diagnostics?: Readonly<Record<string, WebUiRenderer<UiDiagnostic>>>;
  readonly panels?: Readonly<Record<string, WebUiRenderer<UiPanel>>>;
}
export interface WebUiContext { readonly state: UiClientState; readonly command: UiClient["command"] }

/** Unsupported versions, declined renderers and exceptions cannot break the workbench. */
export function extensionContent<T>(renderer: WebUiRenderer<T> | undefined, value: T, context?: WebUiContext): HTMLElement | null {
  try { const node = renderer?.(value, context); return node instanceof HTMLElement ? node : null; }
  catch { return null; }
}
function statusBadge(status: string): HTMLElement { return element("span", `status ${status}`, statusLabel(status)); }
function appendDiagnostic(root: HTMLElement, value: UiDiagnostic, extensions: WebUiExtensions, context?: WebUiContext): void {
  const section = element("section", "diagnostic");
  section.append(element("h4", "", "错误详情"));
  if (value.code) section.append(element("code", "error-code", value.code));
  section.append(element("pre", "tool-content", value.message));
  const custom = value.code ? extensionContent(extensions.diagnostics?.[value.code], value, context) : null;
  if (custom) section.append(custom);
  root.append(section);
}
const statusHint = (status?: string) => status === "unknown" ? "缺少可确认的执行结果；操作可能已产生影响。请在宿主中核对，不要直接重跑。"
  : status === "interrupted" ? "执行已中断；已显示的部分内容不代表完整结果。"
  : status === "not-started" ? "宿主记录此调用未执行。" : "";

export function transcriptBlock(block: UiBlock, extensions: WebUiExtensions = {}, context?: WebUiContext): HTMLElement {
  const article = element("article", `message message-${block.kind}`); article.dataset.id = block.id;
  if (block.kind === "user") { article.append(element("div", "user-bubble", block.text)); return article; }
  if (block.kind === "notice") {
    const notice = element("div", `notice ${block.status ?? ""}`);
    if (block.status) notice.append(statusBadge(block.status));
    notice.append(element("p", "", block.text));
    if (block.diagnostic) appendDiagnostic(notice, block.diagnostic, extensions, context);
    article.append(notice); return article;
  }
  if (block.kind === "tool") {
    const details = element("details", "tool-card");
    const summary = element("summary"); summary.append(icon("code"), element("span", "tool-name", block.title ?? "工具调用"), statusBadge(block.status ?? "unknown"));
    details.append(summary);
    if (block.runId || block.toolCallId) details.append(element("p", "execution-reference", `运行 ${block.runId ?? "—"} · 调用 ${block.toolCallId ?? "—"}`));
    if (block.approval) details.append(element("p", "approval-record", "审批记录：" + ({ pending: "曾请求审批；是否仍可处理，以当前审批区为准", allowed: block.approval.scope === "session" ? "已允许（本会话）" : "已允许（仅此一次）", denied: "已拒绝", cancelled: "审批已取消" }[block.approval.status])));
    const hint = statusHint(block.status);
    if (hint) details.append(element("p", "state-hint", hint));
    if (block.progress) details.append(element("p", "tool-progress", block.progress));
    if (block.input) details.append(element("h4", "", "输入"), element("pre", "tool-content", block.input));
    if (block.text) details.append(element("h4", "", block.status === "completed" ? "输出" : "已收到的输出"), element("pre", "tool-content", block.text));
    if (block.diagnostic) appendDiagnostic(details, block.diagnostic, extensions, context);
    const tool = block.title ? extensionContent(extensions.tools?.[block.title], block, context) : null;
    if (tool) { const supplement = element("div", "tool-extension"); supplement.append(tool); details.append(supplement); }
    if (block.presentation) {
      const custom = extensionContent(extensions.presentations?.[block.presentation.kind]?.[block.presentation.version], block, context);
      details.append(custom ?? element("pre", "tool-content", block.presentation.text));
    }
    article.append(details); return article;
  }
  article.append(element("div", "assistant-label", "May"));
  if (block.reasoning) {
    const reasoning = element("details", "reasoning"); reasoning.append(element("summary", "", "思考过程"), element("div", "reasoning-text", block.reasoning)); article.append(reasoning);
  }
  if (block.text) article.append(markdown(block.text));
  if (block.status === "streaming") article.append(element("span", "streaming-indicator", "生成中…"));
  else {
    if (block.status && block.status !== "completed") article.append(statusBadge(block.status), element("p", "state-hint", statusHint(block.status)));
    if (block.text) {
      const copy = button("复制回答", () => { void navigator.clipboard.writeText(block.text).then(() => { copy.textContent = "已复制"; }, () => { copy.textContent = "复制失败"; }); }, "text-button copy-answer");
      article.append(copy);
    }
  }
  if (block.diagnostic) appendDiagnostic(article, block.diagnostic, extensions, context);
  return article;
}

export function approvalCard(interaction: UiInteraction, decide: (value: string) => void, disabled: boolean, extensions: WebUiExtensions = {}, context?: WebUiContext): HTMLElement {
  const section = element("section", "approval-card"); section.setAttribute("aria-label", interaction.title);
  section.append(element("span", "eyebrow", "当前待审批"), element("h3", "", interaction.title), element("p", "execution-reference", `运行 ${interaction.runId} · 调用 ${interaction.toolCallId}`), element("pre", "tool-content", interaction.detail));
  const custom = extensionContent(extensions.approvalDetails?.[interaction.toolName], interaction, context);
  if (custom) section.append(custom);
  const actions = element("div", "approval-actions");
  for (const choice of interaction.choices) { const b = button(choice.label, () => decide(choice.value), choice.value === "allow" ? "button primary" : "button"); b.disabled = disabled; actions.append(b); }
  section.append(actions); return section;
}
export function detailPanel(panel: UiPanel): HTMLElement {
  const section = element("section", "detail-section"); section.append(element("h3", "", panel.title));
  const list = element("dl"); for (const field of panel.fields) list.append(element("dt", "", field.label), element("dd", "", field.value)); section.append(list); return section;
}
