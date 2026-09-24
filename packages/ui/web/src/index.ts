import type { UiClient, UiClientState, UiResource } from "@may/ui-client";
import { button, detailPanel, extensionContent, element, icon, statusLabel, type WebUiExtensions, type WebUiContext } from "./components.js";
export { approvalCard, detailPanel, transcriptBlock, type WebUiExtensions, type WebUiContext, type WebUiRenderer } from "./components.js";
import { createInspector, createTranscriptReader } from "./reading.js";
import { createCommandUI } from "./commands.js";
import { createNavigation, type WebUiNavigation, type WebUiNavigationGroup, type WebUiNavigationItem, type WebUiNavigationLifecycle } from "./navigation.js";
export type { WebUiNavigationItem, WebUiNavigationGroup, WebUiNavigation, WebUiNavigationLifecycle } from "./navigation.js";
export { createNavigation } from "./navigation.js";
export { markdown } from "./markdown.js";

export interface WebUiAuthentication {
  readonly label: string;
  login(password: string): Promise<string>;
  logout(): Promise<void>;
}
export interface WebUiOptions {
  readonly title?: string;
  readonly kind?: "session" | "task";
  readonly extensions?: WebUiExtensions;
  readonly initialToken?: Promise<string | undefined>;
  readonly connectionHint?: string;
  readonly authentication?: WebUiAuthentication;
  readonly onNew?: (context: WebUiContext) => void | Promise<void>;
  readonly newLabel?: string;
  readonly navigation?: WebUiNavigation | readonly WebUiNavigationGroup[];
}

/** Optional shell. Products can instead compose the exported components with UiClient. */
export function mountWebUI(root: HTMLElement, client: UiClient, options: WebUiOptions = {}): () => void {
  if (options.authentication && options.initialToken !== undefined) throw new Error("authentication and initialToken cannot be combined");

  let state: UiClientState = client.state;
  let localError: string | null = null;
  const errorBox = element("div", "error-banner"); errorBox.hidden = true; errorBox.setAttribute("role", "alert");
  const showError = (error: unknown) => {
    localError = error instanceof Error ? error.message : "操作失败。";
    errorBox.textContent = localError;
    errorBox.hidden = false;
  };
  const act = (name: string, args: Record<string, string> = {}) => { void client.command(name, args).catch(showError); };
  const pending = () => state.busy || state.selecting;
  const has = (name: string) => state.snapshot?.commands.includes(name) ?? false;

  const currentContext = (): WebUiContext => ({
    state,
    command: client.command.bind(client),
    readMedia: client.readMedia.bind(client),
  });

  const shell = element("div", "workbench");
  const sidebar = element("aside", "sidebar"); sidebar.id = "may-sidebar";
  const brand = element("div", "brand"); brand.append(element("span", "brand-mark", "m"), element("span", "brand-name", "May"), element("span", "preview-label", "PREVIEW"));
  const closeSidebar = button("×", () => hideSidebar(), "icon-button sidebar-close"); closeSidebar.setAttribute("aria-label", "关闭侧边栏"); brand.append(closeSidebar);

  const newButton = button("", () => {
    if (options.onNew) {
      try {
        const result = options.onNew(currentContext());
        if (result && typeof (result as Promise<void>).then === "function") {
          void (result as Promise<void>).catch(showError);
        }
      } catch (error) {
        showError(error);
      }
    } else if (state.snapshot?.product.resourceKind === "session") {
      act("session.new");
    } else {
      void client.select().then(() => composer.focus(), showError);
    }
    hideSidebar();
  }, "new-button"); newButton.append(icon("plus"), element("span", "", options.newLabel ?? "新建"));
  const searchLabel = element("label", "search-field"); searchLabel.append(icon("search"));
  const search = element("input"); search.type = "search"; search.placeholder = "搜索历史"; search.setAttribute("aria-label", "搜索会话或任务"); searchLabel.append(search);
  const listTitle = element("div", "sidebar-label", "最近记录");
  const list = element("nav", "resource-list"); list.setAttribute("aria-label", "会话与任务");
  const navComponent = options.navigation ? createNavigation(options.navigation, currentContext, hideSidebar, showError) : undefined;
  const footer = element("div", "sidebar-footer");
  const connectionButton = button("连接本地服务", () => dialog.showModal(), "connection-button");
  const connectionDot = element("span", "connection-dot"); connectionButton.prepend(connectionDot);
  footer.append(connectionButton, element("span", "local-label", "LOCAL WORKSPACE"));
  const resourceMore = button("加载更多记录", () => { void loadResources(true); }); resourceMore.hidden = true;
  const resourceInfo = element("p", "list-empty"); resourceInfo.setAttribute("role", "status");
  sidebar.append(brand, newButton, searchLabel, listTitle, list, resourceMore, resourceInfo, ...(navComponent ? [navComponent.root] : []), footer);

  const backdrop = element("div", "mobile-backdrop");
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.hidden = true;
  backdrop.addEventListener("click", () => {
    hideSidebar();
    hideDetails();
  });

  const main = element("main", "main");
  const header = element("header", "topbar");
  const mobileQuery = matchMedia("(max-width: 760px)");
  const toggle = button("", () => {
    const mobile = mobileQuery.matches;
    const isOpening = mobile ? !shell.classList.contains("sidebar-open") : shell.classList.contains("sidebar-collapsed");
    shell.classList.toggle(mobile ? "sidebar-open" : "sidebar-collapsed");
    syncSidebar();
    if (isOpening) {
      const candidates = sidebar.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex='0']:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
      const focusTarget = Array.from(candidates).find(el => !el.closest("[hidden]") && el.offsetParent !== null) ?? candidates[0];
      focusTarget?.focus();
    }
  }, "icon-button"); toggle.append(icon("menu")); toggle.setAttribute("aria-label", "切换侧边栏"); toggle.setAttribute("aria-controls", sidebar.id);
  function syncSidebar(): void {
    const mobile = mobileQuery.matches;
    const isSidebarOpen = mobile ? shell.classList.contains("sidebar-open") : !shell.classList.contains("sidebar-collapsed");
    toggle.setAttribute("aria-expanded", String(isSidebarOpen));
    sidebar.inert = !isSidebarOpen;
    if (isSidebarOpen) {
      sidebar.removeAttribute("aria-hidden");
    } else {
      sidebar.setAttribute("aria-hidden", "true");
    }
    syncBackdrop();
  }
  function hideSidebar(): void {
    const hadFocus = sidebar.contains(document.activeElement);
    shell.classList.remove("sidebar-open");
    syncSidebar();
    if (hadFocus || (mobileQuery.matches && sidebar.contains(document.activeElement))) toggle.focus();
  }
  function syncBackdrop(): void {
    const mobile = mobileQuery.matches;
    const active = mobile && (shell.classList.contains("sidebar-open") || shell.classList.contains("details-open"));
    backdrop.hidden = !active;
  }
  const onMobileChange = () => {
    syncSidebar();
    syncDetails();
  };
  mobileQuery.addEventListener("change", onMobileChange);
  const productName = element("span", "product-name", options.title ?? "May");
  const productTag = element("span", "product-tag", options.kind === "task" ? "任务" : "工作区");
  const headerLeft = element("div", "header-left"); headerLeft.append(toggle, productName, productTag);
  const badges = element("div", "status-badges"); badges.setAttribute("role", "status"); headerLeft.append(badges);
  const title = element("span", "current-title");
  const detailButton = button("", () => {
    const isOpening = !shell.classList.contains("details-open");
    shell.classList.toggle("details-open");
    syncDetails();
    if (isOpening) {
      const focusTarget = details.querySelector<HTMLElement>("button, [tabindex='0'], input, select, textarea");
      focusTarget?.focus();
    }
  }, "icon-button"); detailButton.append(icon("panel")); detailButton.setAttribute("aria-label", "显示或隐藏详情"); detailButton.setAttribute("aria-expanded", "false");
  header.append(headerLeft, title, detailButton);
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
  const cancel = button("", () => {
    const controls = state.snapshot?.controls;
    if (controls) void client.interact(controls.cancelCommand).catch(showError);
    else act(state.snapshot?.product.resourceKind === "task" ? "task.cancel" : "run.cancel");
  }, "send-button stop-button"); cancel.append(icon("stop")); cancel.setAttribute("aria-label", "取消当前运行"); cancel.hidden = true;
  toolbar.append(choices, cancel, send); form.append(composer, toolbar);
  const composerHint = element("div", "composer-hint", "Enter 发送 · Shift + Enter 换行");
  composerArea.append(form, composerHint);
  main.append(header, errorBox, scroll, composerArea);
  const details = element("aside", "details-panel"); details.setAttribute("aria-label", "详情");
  details.inert = true;
  details.setAttribute("aria-hidden", "true");
  function syncDetails(): void {
    const isDetailsOpen = shell.classList.contains("details-open");
    detailButton.setAttribute("aria-expanded", String(isDetailsOpen));
    details.inert = !isDetailsOpen;
    if (isDetailsOpen) details.removeAttribute("aria-hidden");
    else details.setAttribute("aria-hidden", "true");
    syncBackdrop();
  }
  function hideDetails(): void {
    const hadFocus = details.contains(document.activeElement);
    shell.classList.remove("details-open");
    syncDetails();
    if (hadFocus) detailButton.focus();
  }
  const workspaceDetails = element("div");
  const inspector = createInspector(client, options.extensions ?? {}, open => {
    workspaceDetails.hidden = open;
    if (open) { shell.classList.add("details-open"); syncDetails(); }
  }, () => hideDetails());
  details.append(inspector.root, workspaceDetails);
  const reader = createTranscriptReader(client, { scroll, messages, approvals }, options.extensions ?? {}, block => inspector.inspect(block));
  const commandUI = createCommandUI(client, composer, command => {
    if (command === "/details") { reader.toggleDetails(); return true; }
    if (command === "/thinking") { shell.classList.toggle("hide-reasoning"); return true; }
    return false;
  });
  scroll.append(commandUI.root); form.insertBefore(commandUI.suggestions, composer);
  main.insertBefore(reader.toolbar, scroll);
  shell.append(backdrop, sidebar, main, details);

  const dialog = element("dialog", "connect-dialog");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  const dialogForm = element("form");
  const dialogTitle = element("h2", "", "连接本地工作区"); dialogTitle.id = "connection-title"; dialog.setAttribute("aria-labelledby", dialogTitle.id);
  const explanation = element("p", "", options.connectionHint ?? "输入启动服务时配置的控制令牌。令牌仅保存在当前页面内存中，刷新后需重新连接。");
  const tokenLabel = element("label", "field-label", options.authentication?.label ?? "控制令牌"); tokenLabel.htmlFor = "control-token";
  const tokenInput = element("input", "token-input"); tokenInput.type = "password"; tokenInput.id = "control-token"; tokenInput.required = true; tokenInput.minLength = 32; tokenInput.maxLength = 256; tokenInput.autocomplete = "off";
  if (options.authentication) { tokenInput.minLength = 1; tokenInput.maxLength = 1024; tokenInput.autocomplete = "current-password"; }
  const dialogError = element("p", "dialog-error"); dialogError.setAttribute("role", "alert");
  const dialogActions = element("div", "dialog-actions"); const connectSubmit = element("button", "button primary", "连接"); connectSubmit.type = "submit";
  const disconnect = button("断开连接", () => {
    client.disconnect(); tokenInput.value = "";
    if (options.authentication) void options.authentication.logout().then(() => dialog.close(), error => { dialogError.textContent = error instanceof Error ? error.message : "退出失败"; });
    else dialog.close();
  });
  dialogActions.append(button("关闭", () => dialog.close()), disconnect);
  dialogForm.append(dialogTitle, explanation);
  if (options.initialToken === undefined) {
    dialogForm.append(tokenLabel, tokenInput);
    dialogActions.append(connectSubmit);
  }
  dialogForm.append(dialogError, dialogActions); dialog.append(dialogForm);
  root.replaceChildren(shell, dialog);

  let draftKey = "new", selected: string | null = null;
  const drafts = new Map<string, string>(); let listSignature = "", panelSignature = "", choiceSignature = "", suggestionSignature = "";
  let resourceItems: UiResource[] | null = null, resourceCursor: string | null = null, resourceRequest = 0, resourceHost = "";
  let resourceVersion = "", resourcePages = 1;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadResources(append = false) {
    if (!state.snapshot?.reads?.resources) { renderList(); return; }
    if (append && !resourceCursor) return;
    const id = ++resourceRequest, hostId = state.snapshot.hostId, query = search.value.trim();
    resourceInfo.textContent = "正在读取…"; resourceMore.disabled = true;
    try {
      const items = append ? [...resourceItems ?? []] : [];
      let cursor = append ? resourceCursor : null, pages = append ? resourcePages : 0, total = 0;
      const count = append ? 1 : resourcePages;
      for (let index = 0; index < count; index++) {
        const page = await client.readResources(query, cursor ?? undefined);
        if (id !== resourceRequest || hostId !== state.snapshot?.hostId || query !== search.value.trim()) return;
        items.push(...page.items); cursor = page.nextCursor; total = page.total; pages++;
        if (!cursor) break;
      }
      resourceItems = [...new Map(items.map(item => [item.id, item])).values()];
      resourcePages = pages; resourceCursor = cursor; resourceInfo.textContent = `已加载 ${resourceItems.length} / ${total} 条`;
      renderList();
    } catch (error) { if (id === resourceRequest) resourceInfo.textContent = error instanceof Error ? error.message : "读取失败，请重试搜索。"; }
    finally { if (id === resourceRequest) { resourceMore.disabled = false; resourceMore.hidden = !resourceCursor; } }
  }

  function deleteSession(resource: UiResource): void {
    const hostId = state.snapshot?.hostId, currentId = state.snapshot?.activeId;
    const confirmation = element("dialog", "connect-dialog"), form = element("form");
    const titleId = "delete-session-title-" + Math.random().toString(36).slice(2, 9);
    confirmation.setAttribute("role", "dialog");
    confirmation.setAttribute("aria-modal", "true");
    confirmation.setAttribute("aria-labelledby", titleId);
    const heading = element("h2", "", "删除会话");
    heading.id = titleId;
    const error = element("p", "dialog-error"); error.setAttribute("role", "alert");
    const remove = element("button", "button primary", "删除会话"); remove.type = "submit";
    form.append(heading, element("p", "", `确定删除“${resource.title}”及其历史记录？此操作无法撤销。`), error, button("取消", () => confirmation.close()), remove);
    confirmation.append(form); root.append(confirmation);
    form.onsubmit = event => {
      event.preventDefault();
      if (state.snapshot?.hostId !== hostId || state.snapshot?.activeId !== currentId) { error.textContent = "当前会话已改变，请关闭后重新选择删除操作。"; return; }
      remove.disabled = true;
      void client.command("session.delete", {}, resource.id).then(() => {
        drafts.delete(resource.id); confirmation.close();
      }, reason => { error.textContent = reason instanceof Error ? reason.message : "删除失败。"; remove.disabled = false; });
    };
    confirmation.onclose = () => confirmation.remove(); confirmation.showModal();
  }

  function renderList(): void {
    const snapshot = state.snapshot, query = search.value.trim().toLocaleLowerCase();
    const snapshotResources = snapshot?.resources ?? [];
    const snapshotMap = new Map(snapshotResources.map(r => [r.id, r]));
    const resources = resourceItems === null
      ? (query ? snapshotResources.filter(r => r.title.toLocaleLowerCase().includes(query)) : [...snapshotResources])
      : resourceItems.map(item => snapshotMap.get(item.id) ?? item);
    if (!query && snapshot?.selectedId && !resources.some(item => item.id === snapshot.selectedId)) {
      const selectedResource = snapshotMap.get(snapshot.selectedId);
      if (selectedResource) resources.unshift(selectedResource);
    }
    list.replaceChildren();
    for (const resource of resources) {
      const row = element("div", "resource-row");
      const item = button("", () => {
        void client.select(resource.id).catch(showError);
        hideSidebar();
      }, `resource-item${resource.id === snapshot?.selectedId ? " selected" : ""}`);
      item.disabled = pending() || state.connection !== "connected" || snapshot?.product.resourceKind === "session" && !has("session.activate") && resource.id !== snapshot.activeId;
      if (resource.id === snapshot?.selectedId) item.setAttribute("aria-current", "page");
      item.append(icon(resource.kind === "task" ? "task" : "code"), element("span", "resource-title", resource.title));
      if (resource.status !== "idle") item.append(element("span", `resource-status ${resource.status}`, statusLabel(resource.status)));
      item.title = resource.title; row.append(item);
      if (resource.kind === "session" && resource.id !== snapshot?.activeId) {
        const remove = button("", () => deleteSession(resource), "resource-delete icon-button");
        remove.append(icon("trash")); remove.title = "删除会话";
        remove.setAttribute("aria-label", `删除会话：${resource.title}`);
        remove.disabled = pending() || state.connection !== "connected" || !has("session.delete");
        row.append(remove);
      }
      list.append(row);
    }
    if (!resources.length) list.append(element("p", "list-empty", query ? "没有匹配的记录" : snapshot ? "你的工作会保存在这里" : "连接后查看历史记录"));
  }

  function render(next: UiClientState): void {
    state = next;
    const snapshot = state.snapshot, connected = state.connection === "connected";
    const nextSelected = snapshot?.selectedId ?? null;
    const changedSelection = selected !== nextSelected;
    if (changedSelection) { drafts.set(draftKey, composer.value); selected = nextSelected; draftKey = selected ?? "new"; composer.value = drafts.get(draftKey) ?? "";  }
    connectionButton.lastChild!.textContent = ({ connected: "已连接本地服务", connecting: "正在连接…", reconnecting: "连接中断，重连中…", disconnected: "连接本地服务" })[state.connection];
    connectionDot.className = `connection-dot ${state.connection}`;
    productName.textContent = snapshot?.product.title ?? options.title ?? "May";
    const isTask = (snapshot?.product.resourceKind ?? options.kind) === "task";
    productTag.textContent = isTask ? "任务" : "工作区";
    badges.replaceChildren(...(snapshot?.badges ?? []).map(badge =>
      element("span", `product-tag status-badge ${badge.tone === "warning" ? "warning" : "neutral"}`, badge.label)));
    header.classList.toggle("has-status-badges", Boolean(snapshot?.badges?.length));
    newButton.lastChild!.textContent = options.newLabel ?? (isTask ? "新建任务" : "新建会话");
    newButton.disabled = !connected || pending() || (!options.onNew && !has(isTask ? "task.submit" : "session.new"));
    listTitle.textContent = isTask ? "最近任务" : "最近会话";
    const snapshotResources = snapshot?.resources ?? [];
    const snapshotMap = new Map(snapshotResources.map(r => [r.id, r]));
    const active = snapshotMap.get(snapshot?.selectedId ?? "");
    title.textContent = active?.title ?? "";
    const nextResourceVersion = snapshot?.resourcesVersion ?? `${snapshotResources.length}:${snapshotResources[0]?.id ?? ""}:${snapshotResources[0]?.title ?? ""}`;
    const changedHost = resourceHost !== (snapshot?.hostId ?? "");
    if (changedHost) {
      resourceHost = snapshot?.hostId ?? ""; resourceRequest++; resourceItems = null; resourceCursor = null; resourceInfo.textContent = ""; resourceMore.hidden = true;
      resourcePages = 1;
    }
    if (changedHost || resourceVersion !== nextResourceVersion) {
      resourceVersion = nextResourceVersion;
      clearTimeout(searchTimer);
      if (snapshot?.reads?.resources) void loadResources();
    }
    const sig = JSON.stringify([snapshot?.resources, selected, snapshot?.activeId, pending(), snapshot?.commands, connected]);
    if (sig !== listSignature) { listSignature = sig; renderList(); }
    navComponent?.update(state);
    const displayError = state.error ?? localError;
    errorBox.textContent = displayError ?? ""; errorBox.hidden = !displayError;
    inspector.update(state); reader.update(state); commandUI.update(state);
    const visibleBlocks = snapshot?.blocks ?? [];
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
    const choicesKey = JSON.stringify([snapshot?.choices, pending(), snapshot?.commands, state.connection]);
    if (choicesKey !== choiceSignature) {
      choiceSignature = choicesKey; choices.replaceChildren();
      for (const choice of snapshot?.choices ?? []) {
        const select = element("select", "model-select"); select.setAttribute("aria-label", choice.label);
        for (const item of choice.options) { const option = element("option", "", item.label); option.value = item.value; select.append(option); }
        select.value = choice.value; select.disabled = !connected || pending() || !has(choice.command); select.onchange = () => act(choice.command, { value: select.value }); choices.append(select);
      }
      if (!snapshot?.choices.length) choices.append(element("span", "composer-mode", isTask ? "持久任务" : "本地 Agent"));
    }
    cancel.hidden = state.snapshot?.controls ? !(state.busy || state.snapshot.controls.busy || has("run.cancel")) : !has(isTask ? "task.cancel" : "run.cancel"); cancel.disabled = !connected || (state.snapshot?.controls ? state.selecting : pending());
    send.hidden = !cancel.hidden;
    updateComposer();
    composerHint.textContent = !connected ? "需要连接本地服务 · 不会自动发送输入" : isTask && selected ? "关闭页面不会中止任务 · 执行、验证与送达分别记录" : "Enter 发送 · Shift + Enter 换行 · 请核对 Agent 的输出";
    const panelsKey = JSON.stringify([snapshot?.panels, snapshot?.notice, snapshot?.commands, pending()]);
    if (panelsKey !== panelSignature) {
      panelSignature = panelsKey; workspaceDetails.replaceChildren();
      const detailsHeader = element("div", "details-header"); detailsHeader.append(element("h2", "", "工作详情"), button("关闭", hideDetails, "text-button")); workspaceDetails.append(detailsHeader);
      for (const panel of snapshot?.panels ?? []) workspaceDetails.append(extensionContent(options.extensions?.panels?.[panel.id], panel, { state, command: client.command.bind(client) }) ?? detailPanel(panel));
      const actions = element("div", "detail-actions");
      for (const [command, label] of [["context.compact", "压缩上下文"], ["task.recover", "核对恢复证据"], ["task.dispatch", "重新请求调度"]]) if (has(command!)) {
        const action = button(label!, () => act(command!)); action.disabled = pending(); actions.append(action);
      }
      if (has("session.rename")) actions.append(button("重命名会话", () => {
        const current = title.textContent ?? "";
        const rename = element("dialog", "connect-dialog"); const renameForm = element("form"); const input = element("input", "token-input"); input.value = current; input.maxLength = 160; input.required = true; input.setAttribute("aria-label", "会话名称");
        const renameTitleId = "rename-session-title-" + Math.random().toString(36).slice(2, 9);
        rename.setAttribute("role", "dialog");
        rename.setAttribute("aria-modal", "true");
        rename.setAttribute("aria-labelledby", renameTitleId);
        const renameHeading = element("h2", "", "重命名会话");
        renameHeading.id = renameTitleId;
        const save = element("button", "button primary", "保存"); save.type = "submit";
        renameForm.append(renameHeading, input, button("取消", () => rename.close()), save); rename.append(renameForm); root.append(rename);
        renameForm.onsubmit = event => { event.preventDefault(); act("session.rename", { title: input.value }); rename.close(); };
        rename.onclose = () => rename.remove(); rename.showModal();
      }));
      workspaceDetails.append(actions);
      if (snapshot?.notice) workspaceDetails.append(element("p", "detail-note", snapshot.notice));
    }
  }
  function updateComposer(): void {
    send.disabled = !composer.value.trim() || pending() || state.connection !== "connected" || !(has("message.submit") || has("task.submit") && !selected || state.snapshot?.controls && has(state.snapshot.controls.inputCommand));
    composer.rows = Math.min(8, Math.max(2, composer.value.split("\n").length));
  }
  composer.oninput = () => { drafts.set(draftKey, composer.value); updateComposer(); };
  composer.onkeydown = event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!send.disabled && !send.hidden) form.requestSubmit(); } };
  form.onsubmit = event => {
    event.preventDefault(); if (send.disabled) return;
    const text = composer.value, key = draftKey;
    void commandUI.submit(text).then(handled => handled ? undefined : client.command(state.snapshot?.product.resourceKind === "task" ? "task.submit" : "message.submit", { text })).then(() => { drafts.delete(key); if (draftKey === key && composer.value === text) composer.value = ""; updateComposer(); }, showError);
  };
  dialogForm.onsubmit = event => {
    event.preventDefault();
    if (options.initialToken !== undefined) return;
    connectSubmit.disabled = true; dialogError.textContent = "";
    const credential = tokenInput.value; tokenInput.value = "";
    const login = options.authentication ? options.authentication.login(credential) : Promise.resolve(credential.trim());
    void login.then(token => client.connect(token)).then(() => { dialog.close(); }, error => { dialogError.textContent = error instanceof Error ? error.message : "连接失败"; }).finally(() => { connectSubmit.disabled = false; });
  };
  search.maxLength = 256;
  search.oninput = () => {
    clearTimeout(searchTimer); resourceRequest++; resourceItems = null; resourceCursor = null; resourcePages = 1;
    if (!state.snapshot?.reads?.resources) renderList();
    else { resourceItems = []; renderList(); searchTimer = setTimeout(() => { void loadResources(); }, 250); }
  };
  const keyboard = (event: KeyboardEvent) => {
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Tab" && mobileQuery.matches) {
      const panel = shell.classList.contains("sidebar-open") ? sidebar : shell.classList.contains("details-open") ? details : undefined;
      if (panel) {
        const controls = Array.from(panel.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]")).filter(control => control.tabIndex >= 0 && !control.matches(":disabled") && !control.closest("[hidden], [inert]") && control.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (first && last && (!panel.contains(document.activeElement) || (event.shiftKey ? document.activeElement === first : document.activeElement === last))) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); shell.classList.add("sidebar-open"); shell.classList.remove("sidebar-collapsed"); syncSidebar(); search.focus(); }
    if (event.key === "Escape") {
      const activeDialog = document.querySelector("dialog[open]");
      if (!activeDialog) {
        if (localError || !errorBox.hidden) {
          localError = null;
          errorBox.hidden = true;
          errorBox.textContent = "";
        } else {
          hideSidebar();
          hideDetails();
        }
      }
    }
  };
  document.addEventListener("keydown", keyboard);
  syncSidebar();
  syncDetails();
  const unsubscribe = client.subscribe(render);
  let disposed = false;
  void options.initialToken?.then(token => { if (!disposed && token !== undefined) return client.connect(token); }).catch(error => { if (!disposed) showError(error); });
  return () => { disposed = true; resourceRequest++; clearTimeout(searchTimer); navComponent?.dispose(); commandUI.dispose(); reader.dispose(); inspector.dispose(); unsubscribe(); client.disconnect(); document.removeEventListener("keydown", keyboard); mobileQuery.removeEventListener("change", onMobileChange); root.replaceChildren(); };
}
