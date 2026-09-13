import type { UiClient, UiClientState, UiSnapshot } from "@may/ui-client";
import { approvalCard, button, detailPanel, element, icon, statusLabel, transcriptBlock, type WebUiExtensions } from "./components.js";
export { approvalCard, detailPanel, transcriptBlock, type WebUiExtensions, type WebUiContext } from "./components.js";
export { markdown } from "./markdown.js";

export interface WebUiOptions { readonly title?: string; readonly kind?: "session" | "task"; readonly extensions?: WebUiExtensions }

/** Optional shell. Products can instead compose the exported components with UiClient. */
export function mountWebUI(root: HTMLElement, client: UiClient, options: WebUiOptions = {}): () => void {
  const shell = element("div", "workbench");
  const sidebar = element("aside", "sidebar"); sidebar.id = "may-sidebar";
  const brand = element("div", "brand"); brand.append(element("span", "brand-mark", "m"), element("span", "brand-name", "May"), element("span", "preview-label", "PREVIEW"));
  const closeSidebar = button("×", () => hideSidebar(), "icon-button sidebar-close"); closeSidebar.setAttribute("aria-label", "关闭侧边栏"); brand.append(closeSidebar);
  const newButton = button("", () => {
    if (state.snapshot?.product.resourceKind === "session") act("session.new");
    else { void client.select().then(() => composer.focus(), showError); }
    hideSidebar();
  }, "new-button"); newButton.append(icon("plus"), element("span", "", "新建"));
  const searchLabel = element("label", "search-field"); searchLabel.append(icon("search"));
  const search = element("input"); search.type = "search"; search.placeholder = "搜索历史"; search.setAttribute("aria-label", "搜索会话或任务"); searchLabel.append(search);
  const listTitle = element("div", "sidebar-label", "最近记录");
  const list = element("nav", "resource-list"); list.setAttribute("aria-label", "会话与任务");
  const footer = element("div", "sidebar-footer");
  const connectionButton = button("连接本地服务", () => dialog.showModal(), "connection-button");
  const connectionDot = element("span", "connection-dot"); connectionButton.prepend(connectionDot);
  footer.append(connectionButton, element("span", "local-label", "LOCAL WORKSPACE"));
  sidebar.append(brand, newButton, searchLabel, listTitle, list, footer);

  const main = element("main", "main");
  const header = element("header", "topbar");
  const toggle = button("", () => {
    const mobile = mobileQuery.matches;
    shell.classList.toggle(mobile ? "sidebar-open" : "sidebar-collapsed");
    syncSidebar();
  }, "icon-button"); toggle.append(icon("menu")); toggle.setAttribute("aria-label", "切换侧边栏"); toggle.setAttribute("aria-controls", sidebar.id);
  const mobileQuery = matchMedia("(max-width: 760px)");
  function syncSidebar(): void { toggle.setAttribute("aria-expanded", String(mobileQuery.matches ? shell.classList.contains("sidebar-open") : !shell.classList.contains("sidebar-collapsed"))); }
  function hideSidebar(): void { shell.classList.remove("sidebar-open"); syncSidebar(); if (mobileQuery.matches && sidebar.contains(document.activeElement)) toggle.focus(); }
  syncSidebar(); mobileQuery.addEventListener("change", syncSidebar);
  const productName = element("span", "product-name", options.title ?? "May");
  const productTag = element("span", "product-tag", options.kind === "task" ? "任务" : "工作区");
  const headerLeft = element("div", "header-left"); headerLeft.append(toggle, productName, productTag);
  const title = element("span", "current-title");
  const detailButton = button("", () => { shell.classList.toggle("details-open"); detailButton.setAttribute("aria-expanded", String(shell.classList.contains("details-open"))); }, "icon-button"); detailButton.append(icon("panel")); detailButton.setAttribute("aria-label", "显示或隐藏详情"); detailButton.setAttribute("aria-expanded", "false");
  header.append(headerLeft, title, detailButton);
  const errorBox = element("div", "error-banner"); errorBox.hidden = true; errorBox.setAttribute("role", "alert");
  const scroll = element("div", "conversation-scroll");
  const welcome = element("section", "welcome");
  const welcomeMark = element("div", "welcome-mark", "m");
  const welcomeTitle = element("h1", "", options.kind === "task" ? "把下一件事交给 May" : "从一个想法开始");
  const welcomeText = element("p", "", "连接本地服务，开始你的工作。");
  const suggestions = element("div", "suggestions");
  welcome.append(welcomeMark, welcomeTitle, welcomeText, suggestions);
  const messages = element("div", "messages"); messages.setAttribute("aria-label", "对话记录");
  const approvals = element("div", "approvals");
  scroll.append(welcome, messages, approvals);

  const composerArea = element("div", "composer-area");
  const form = element("form", "composer");
  const composer = element("textarea"); composer.rows = 2; composer.maxLength = 16_384; composer.placeholder = "描述你想完成的事…"; composer.setAttribute("aria-label", "消息输入");
  const toolbar = element("div", "composer-toolbar"); const choices = element("div", "composer-choices");
  const send = element("button", "send-button"); send.type = "submit"; send.append(icon("send")); send.setAttribute("aria-label", "发送消息");
  const cancel = button("", () => act(state.snapshot?.product.resourceKind === "task" ? "task.cancel" : "run.cancel"), "send-button stop-button"); cancel.append(icon("stop")); cancel.setAttribute("aria-label", "取消当前运行"); cancel.hidden = true;
  toolbar.append(choices, cancel, send); form.append(composer, toolbar);
  const composerHint = element("div", "composer-hint", "Enter 发送 · Shift + Enter 换行");
  composerArea.append(form, composerHint);
  main.append(header, errorBox, scroll, composerArea);
  const details = element("aside", "details-panel"); details.setAttribute("aria-label", "详情");
  shell.append(sidebar, main, details);

  const dialog = element("dialog", "connect-dialog");
  const dialogForm = element("form");
  const dialogTitle = element("h2", "", "连接本地工作区"); dialogTitle.id = "connection-title"; dialog.setAttribute("aria-labelledby", dialogTitle.id);
  const explanation = element("p", "", "输入启动服务时配置的控制令牌。令牌仅保存在当前页面内存中，刷新后需重新连接。");
  const tokenLabel = element("label", "field-label", "控制令牌"); tokenLabel.htmlFor = "control-token";
  const tokenInput = element("input", "token-input"); tokenInput.type = "password"; tokenInput.id = "control-token"; tokenInput.required = true; tokenInput.minLength = 32; tokenInput.maxLength = 256; tokenInput.autocomplete = "off";
  const dialogError = element("p", "dialog-error"); dialogError.setAttribute("role", "alert");
  const dialogActions = element("div", "dialog-actions"); const connectSubmit = element("button", "button primary", "连接"); connectSubmit.type = "submit";
  const disconnect = button("断开连接", () => { client.disconnect(); tokenInput.value = ""; dialog.close(); });
  dialogActions.append(button("关闭", () => dialog.close()), disconnect, connectSubmit);
  dialogForm.append(dialogTitle, explanation, tokenLabel, tokenInput, dialogError, dialogActions); dialog.append(dialogForm);
  root.replaceChildren(shell, dialog);

  let state: UiClientState = client.state, draftKey = "new", selected: string | null = null;
  const drafts = new Map<string, string>(); let listSignature = "", panelSignature = "", choiceSignature = "", suggestionSignature = "", approvalSignature = "";
  const blocks = new Map<string, { signature: string; node: HTMLElement }>();
  const showError = (error: unknown) => { errorBox.textContent = error instanceof Error ? error.message : "操作失败。"; errorBox.hidden = false; };
  const act = (name: string, args: Record<string, string> = {}) => { void client.command(name, args).catch(showError); };
  const has = (name: string) => state.snapshot?.commands.includes(name) ?? false;

  function renderList(): void {
    const snapshot = state.snapshot, query = search.value.trim().toLocaleLowerCase();
    const resources = snapshot?.resources.filter(r => r.title.toLocaleLowerCase().includes(query)) ?? [];
    list.replaceChildren();
    for (const resource of resources) {
      const item = button("", () => {
        if (snapshot?.product.resourceKind === "session") act("session.open", { id: resource.id });
        else void client.select(resource.id).catch(showError);
        hideSidebar();
      }, `resource-item${resource.id === snapshot?.selectedId ? " selected" : ""}`);
      item.disabled = state.busy || snapshot?.product.resourceKind === "session" && !has("session.open");
      if (resource.id === snapshot?.selectedId) item.setAttribute("aria-current", "page");
      item.append(icon(resource.kind === "task" ? "task" : "code"), element("span", "resource-title", resource.title));
      if (resource.status !== "idle") item.append(element("span", `resource-status ${resource.status}`, statusLabel(resource.status)));
      item.title = resource.title; list.append(item);
    }
    if (!resources.length) list.append(element("p", "list-empty", query ? "没有匹配的记录" : snapshot ? "你的工作会保存在这里" : "连接后查看历史记录"));
  }

  function render(next: UiClientState): void {
    state = next;
    const snapshot = state.snapshot, connected = state.connection === "connected";
    const nextSelected = snapshot?.selectedId ?? null;
    const changedSelection = selected !== nextSelected;
    if (changedSelection) { drafts.set(draftKey, composer.value); selected = nextSelected; draftKey = selected ?? "new"; composer.value = drafts.get(draftKey) ?? ""; blocks.clear(); messages.replaceChildren(); }
    connectionButton.lastChild!.textContent = ({ connected: "已连接本地服务", connecting: "正在连接…", reconnecting: "连接中断，重连中…", disconnected: "连接本地服务" })[state.connection];
    connectionDot.className = `connection-dot ${state.connection}`;
    productName.textContent = snapshot?.product.title ?? options.title ?? "May";
    const isTask = (snapshot?.product.resourceKind ?? options.kind) === "task";
    productTag.textContent = isTask ? "任务" : "工作区";
    newButton.lastChild!.textContent = isTask ? "新建任务" : "新建会话";
    newButton.disabled = !connected || state.busy || !has(isTask ? "task.submit" : "session.new");
    listTitle.textContent = isTask ? "最近任务" : "最近会话";
    const active = snapshot?.resources.find(r => r.id === snapshot.selectedId);
    title.textContent = active?.title ?? "";
    const sig = JSON.stringify([snapshot?.resources, selected, state.busy, snapshot?.commands]);
    if (sig !== listSignature) { listSignature = sig; renderList(); }
    errorBox.textContent = state.error ?? ""; errorBox.hidden = !state.error;
    const nearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
    const visibleBlocks = snapshot?.blocks ?? [];
    const ids = new Set(visibleBlocks.map(block => block.id));
    for (const [id, entry] of blocks) if (!ids.has(id)) { entry.node.remove(); blocks.delete(id); }
    for (const block of visibleBlocks) {
      const signature = JSON.stringify(block), previous = blocks.get(block.id);
      if (previous?.signature === signature) continue;
      const node = transcriptBlock(block, options.extensions, { state, command: client.command.bind(client) });
      if (previous) {
        const open = previous.node.querySelector("details")?.open;
        if (open && node.querySelector("details")) node.querySelector("details")!.open = true;
        previous.node.replaceWith(node);
      } else messages.append(node);
      blocks.set(block.id, { signature, node });
    }
    const approvalKey = JSON.stringify([snapshot?.interactions, connected, state.busy]);
    if (approvalKey !== approvalSignature) {
      approvalSignature = approvalKey;
      approvals.replaceChildren(...(snapshot?.interactions ?? []).map(interaction => approvalCard(interaction, decision => act("approval.resolve", { id: interaction.id, decision }), !connected || state.busy)));
    }
    welcome.hidden = visibleBlocks.length > 0;
    welcomeTitle.textContent = isTask ? "把下一件事交给 May" : "今天，一起构建什么？";
    welcomeText.textContent = snapshot?.product.subtitle ?? "连接你的本地 Agent。对话、工具与执行状态，在同一个工作区。";
    const suggestionsKey = JSON.stringify(snapshot?.product.suggestions ?? []);
    if (suggestionsKey !== suggestionSignature) {
      suggestionSignature = suggestionsKey; suggestions.replaceChildren();
      for (const text of snapshot?.product.suggestions ?? []) { const suggestion = button("", () => { composer.value = text; composer.focus(); drafts.set(draftKey, text); updateComposer(); }, "suggestion"); suggestion.append(element("span", "", text), icon("arrow")); suggestions.append(suggestion); }
    }
    composer.placeholder = isTask && selected ? "当前任务已提交；新建任务以开始另一项工作" : isTask ? "描述任务、预期结果与约束…" : "描述需求、提问，或一起解决一个问题…";
    composer.disabled = Boolean(isTask && selected);
    const choicesKey = JSON.stringify([snapshot?.choices, state.busy, snapshot?.commands, state.connection]);
    if (choicesKey !== choiceSignature) {
      choiceSignature = choicesKey; choices.replaceChildren();
      for (const choice of snapshot?.choices ?? []) {
        const select = element("select", "model-select"); select.setAttribute("aria-label", choice.label);
        for (const item of choice.options) { const option = element("option", "", item.label); option.value = item.value; select.append(option); }
        select.value = choice.value; select.disabled = !connected || state.busy || !has(choice.command); select.onchange = () => act(choice.command, { value: select.value }); choices.append(select);
      }
      if (!snapshot?.choices.length) choices.append(element("span", "composer-mode", isTask ? "持久任务" : "本地 Agent"));
    }
    cancel.hidden = !has(isTask ? "task.cancel" : "run.cancel"); cancel.disabled = !connected || state.busy;
    send.hidden = !cancel.hidden;
    updateComposer();
    composerHint.textContent = !connected ? "需要连接本地服务 · 不会自动发送输入" : isTask && selected ? "关闭页面不会中止任务 · 执行、验证与送达分别记录" : "Enter 发送 · Shift + Enter 换行 · 请核对 Agent 的输出";
    const panelsKey = JSON.stringify([snapshot?.panels, snapshot?.notice, snapshot?.commands, state.busy]);
    if (panelsKey !== panelSignature) {
      panelSignature = panelsKey; details.replaceChildren();
      const detailsHeader = element("div", "details-header"); detailsHeader.append(element("h2", "", "工作详情"), button("关闭", hideDetails, "text-button")); details.append(detailsHeader);
      for (const panel of snapshot?.panels ?? []) details.append(options.extensions?.panels?.[panel.id]?.(panel, { state, command: client.command.bind(client) }) ?? detailPanel(panel));
      const actions = element("div", "detail-actions");
      for (const [command, label] of [["context.compact", "压缩上下文"], ["task.recover", "核对恢复证据"], ["task.dispatch", "重新请求调度"]]) if (has(command!)) {
        const action = button(label!, () => act(command!)); action.disabled = state.busy; actions.append(action);
      }
      if (has("session.rename")) actions.append(button("重命名会话", () => {
        const current = title.textContent ?? "";
        const rename = element("dialog", "connect-dialog"); const renameForm = element("form"); const input = element("input", "token-input"); input.value = current; input.maxLength = 160; input.required = true; input.setAttribute("aria-label", "会话名称");
        const save = element("button", "button primary", "保存"); save.type = "submit";
        renameForm.append(element("h2", "", "重命名会话"), input, button("取消", () => rename.close()), save); rename.append(renameForm); root.append(rename);
        renameForm.onsubmit = event => { event.preventDefault(); act("session.rename", { title: input.value }); rename.close(); };
        rename.onclose = () => rename.remove(); rename.showModal();
      }));
      details.append(actions);
      if (snapshot?.notice) details.append(element("p", "detail-note", snapshot.notice));
    }
    if (nearBottom || changedSelection) scroll.scrollTop = scroll.scrollHeight;
  }
  function updateComposer(): void {
    send.disabled = !composer.value.trim() || state.busy || state.connection !== "connected" || !(has("message.submit") || has("task.submit") && !selected);
    composer.rows = Math.min(8, Math.max(2, composer.value.split("\n").length));
  }
  composer.oninput = () => { drafts.set(draftKey, composer.value); updateComposer(); };
  composer.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled && !send.hidden) form.requestSubmit(); } };
  form.onsubmit = event => {
    event.preventDefault(); if (send.disabled) return;
    const text = composer.value, key = draftKey;
    void client.command(state.snapshot?.product.resourceKind === "task" ? "task.submit" : "message.submit", { text }).then(() => { drafts.delete(key); if (draftKey === key && composer.value === text) composer.value = ""; updateComposer(); }, showError);
  };
  dialogForm.onsubmit = event => {
    event.preventDefault(); connectSubmit.disabled = true; dialogError.textContent = "";
    void client.connect(tokenInput.value.trim()).then(() => { tokenInput.value = ""; dialog.close(); }, error => { dialogError.textContent = error instanceof Error ? error.message : "连接失败"; }).finally(() => { connectSubmit.disabled = false; });
  };
  search.oninput = renderList;
  function hideDetails(): void { shell.classList.remove("details-open"); detailButton.setAttribute("aria-expanded", "false"); if (details.contains(document.activeElement)) detailButton.focus(); }
  const keyboard = (event: KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); shell.classList.add("sidebar-open"); shell.classList.remove("sidebar-collapsed"); syncSidebar(); search.focus(); }
    if (event.key === "Escape") { hideSidebar(); hideDetails(); }
  };
  document.addEventListener("keydown", keyboard);
  const unsubscribe = client.subscribe(render);
  return () => { unsubscribe(); client.disconnect(); document.removeEventListener("keydown", keyboard); mobileQuery.removeEventListener("change", syncSidebar); root.replaceChildren(); };
}
