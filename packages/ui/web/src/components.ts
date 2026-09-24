import type { UiBlock, UiInteraction, UiPanel, UiClient, UiClientState, UiDiagnostic } from "@may/ui-client";
import { markdown } from "./markdown.js";

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el;
}
export function button(label: string, action: () => void, className = "button"): HTMLButtonElement {
  const el = element("button", className, label); el.type = "button"; el.onclick = action; return el;
}
export function icon(name: "plus" | "menu" | "send" | "stop" | "panel" | "search" | "arrow" | "code" | "task" | "trash" | "gear" | "users" | "message" | "check" | "filter") {
  const paths = {
    plus: "M12 5v14M5 12h14",
    menu: "M4 6h16M4 12h16M4 18h16",
    send: "M12 19V5m-6 6 6-6 6 6",
    stop: "M6 6h12v12H6z",
    panel: "M4 4h16v16H4zM14 4v16",
    search: "m16 16 4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    arrow: "M7 17 17 7M7 7h10v10",
    code: "m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16",
    task: "M8 5h12M8 12h12M8 19h12M3 5h.01M3 12h.01M3 19h.01",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z",
    users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75",
    message: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
    check: "M20 6 9 17l-5-5",
    filter: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z",
  };
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
export interface WebUiContext { readonly state: UiClientState; readonly command: UiClient["command"]; readonly readMedia?: UiClient["readMedia"] }

function messageContent(block: UiBlock, context?: WebUiContext): HTMLElement {
  const root = element("div", "message-content");
  for (const part of block.content ?? [{ type: "text", text: block.text }]) {
    if (part.type === "text") { root.append(markdown(part.text)); continue; }
    const attachment = part.image;
    if (!customElements.get("may-image")) customElements.define("may-image", class extends HTMLElement {
      load?: (signal: AbortSignal) => Promise<Blob>;
      private controller?: AbortController;
      private url: string | undefined;
      connectedCallback() {
        if (!this.load) return;
        const controller = new AbortController(); this.controller = controller;
        this.textContent = "正在读取图片…";
        void this.load(controller.signal).then(blob => {
          if (controller.signal.aborted) return;
          this.url = URL.createObjectURL(blob);
          const image = element("img", "reply-image"); image.src = this.url; image.alt = "回复中的图片";
          const open = element("a", "text-button", "查看原图"); open.href = this.url; open.target = "_blank"; open.rel = "noopener";
          const save = element("a", "text-button", "下载图片"); save.href = this.url; save.download = `image.${blob.type.slice(6)}`;
          this.replaceChildren(image, open, document.createTextNode(" · "), save);
        }, error => { if (!controller.signal.aborted) this.textContent = error instanceof Error ? error.message : "图片读取失败。"; });
      }
      disconnectedCallback() { this.controller?.abort(); if (this.url) URL.revokeObjectURL(this.url); this.url = undefined; }
    });
    if (attachment.url) {
      const image = element("img", "reply-image"); image.src = attachment.url; image.alt = "回复中的图片"; image.loading = "lazy"; image.referrerPolicy = "no-referrer"; root.append(image);
      const link = element("a", "text-button", "打开图片链接"); link.href = attachment.url; link.target = "_blank"; link.rel = "noopener noreferrer"; root.append(link);
    } else if (context?.readMedia) {
      const image = document.createElement("may-image") as HTMLElement & { load: (signal: AbortSignal) => Promise<Blob> };
      image.load = signal => context.readMedia!(attachment.id, signal); root.append(image);
    } else root.append(element("p", "", `图片 ${attachment.id}：当前宿主未提供媒体读取接口。`));
  }
  return root;
}

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
  if (block.kind === "user") { const bubble = element("div", "user-bubble"); bubble.append(messageContent(block, context)); article.append(bubble); return article; }
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
    if (block.content?.some(part => part.type === "image")) details.append(messageContent(block, context));
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
  if (block.content?.length || block.text) article.append(messageContent(block, context));
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
