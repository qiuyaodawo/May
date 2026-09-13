import type { UiBlock, UiInteraction, UiPanel, UiClient, UiClientState } from "@may/ui-client";
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
export const statusLabel = (status: string): string => ({ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", blocked: "待处理", idle: "空闲", streaming: "正在生成", interrupted: "已停止", unverified: "尚未验证", disabled: "未启用", delivered: "已送达", pending: "待处理", unknown: "结果未知" }[status] ?? status);

/** Trusted host-application extensions, never JavaScript supplied by an agent event. */
export interface WebUiExtensions {
  readonly presentations?: Readonly<Record<string, (block: UiBlock, context?: WebUiContext) => HTMLElement>>;
  readonly panels?: Readonly<Record<string, (panel: UiPanel, context?: WebUiContext) => HTMLElement>>;
}
export interface WebUiContext { readonly state: UiClientState; readonly command: UiClient["command"] }

export function transcriptBlock(block: UiBlock, extensions: WebUiExtensions = {}, context?: WebUiContext): HTMLElement {
  const article = element("article", `message message-${block.kind}`); article.dataset.id = block.id;
  if (block.kind === "user") { article.append(element("div", "user-bubble", block.text)); return article; }
  if (block.kind === "notice") { article.append(element("div", "notice", block.text)); return article; }
  if (block.kind === "tool") {
    const details = element("details", "tool-card");
    const summary = element("summary"); summary.append(icon("code"), element("span", "tool-name", block.title ?? "工具调用"), element("span", `status ${block.status ?? ""}`, statusLabel(block.status ?? "running")));
    details.append(summary);
    if (block.input) details.append(element("h4", "", "输入"), element("pre", "tool-content", block.input));
    if (block.text) details.append(element("h4", "", "输出"), element("pre", "tool-content", block.text));
    if (block.presentation) {
      const custom = extensions.presentations?.[block.presentation.kind];
      details.append(custom ? custom(block, context) : element("pre", "tool-content", block.presentation.text));
    }
    article.append(details); return article;
  }
  article.append(element("div", "assistant-label", "May"));
  if (block.reasoning) {
    const reasoning = element("details", "reasoning"); reasoning.append(element("summary", "", "思考过程"), element("div", "reasoning-text", block.reasoning)); article.append(reasoning);
  }
  if (block.text) article.append(markdown(block.text));
  if (block.status === "streaming") article.append(element("span", "streaming-indicator", "生成中…"));
  else if (block.text) {
    const copy = button("复制回答", () => { void navigator.clipboard.writeText(block.text).then(() => { copy.textContent = "已复制"; }, () => { copy.textContent = "复制失败"; }); }, "text-button copy-answer");
    article.append(copy);
  }
  return article;
}

export function approvalCard(interaction: UiInteraction, decide: (value: string) => void, disabled: boolean): HTMLElement {
  const section = element("section", "approval-card"); section.setAttribute("aria-label", interaction.title);
  section.append(element("span", "eyebrow", "需要你的确认"), element("h3", "", interaction.title), element("pre", "tool-content", interaction.detail));
  const actions = element("div", "approval-actions");
  for (const choice of interaction.choices) { const b = button(choice.label, () => decide(choice.value), choice.value === "allow" ? "button primary" : "button"); b.disabled = disabled; actions.append(b); }
  section.append(actions); return section;
}
export function detailPanel(panel: UiPanel): HTMLElement {
  const section = element("section", "detail-section"); section.append(element("h3", "", panel.title));
  const list = element("dl"); for (const field of panel.fields) list.append(element("dt", "", field.label), element("dd", "", field.value)); section.append(list); return section;
}
