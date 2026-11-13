import type { UiClient, UiClientState } from "@sortedyuan/ui-client";
import {
  button,
  detailPanel,
  extensionContent,
  element,
  icon,
  type WebUiExtensions,
  type WebUiContext,
} from "./components.js";
export {
  approvalCard,
  detailPanel,
  transcriptBlock,
  type WebUiExtensions,
  type WebUiContext,
  type WebUiRenderer,
} from "./components.js";
import { createTranscriptReader } from "./reading.js";
import { createInspector } from "./inspector.js";
import { createResourceList } from "./resource-list.js";
import { createConnectionDialog } from "./connection-dialog.js";
import { createComposer } from "./composer.js";
import { createCommandUI } from "./commands.js";
import { createWorkspaceUI } from "./workspace.js";
import { createUiTasks } from "./tasks.js";
export { createWorkspaceUI } from "./workspace.js";
import {
  createNavigation,
  type WebUiNavigation,
  type WebUiNavigationGroup,
  type WebUiNavigationItem,
  type WebUiNavigationLifecycle,
} from "./navigation.js";
export type {
  WebUiNavigationItem,
  WebUiNavigationGroup,
  WebUiNavigation,
  WebUiNavigationLifecycle,
} from "./navigation.js";
export { createNavigation } from "./navigation.js";
export { markdown } from "./markdown.js";

/** @experimental */
export interface WebUiAuthentication {
  readonly label: string;
  login(password: string): Promise<string>;
  logout(): Promise<void>;
}
/** @experimental */
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

/**
 * Optional shell. Products can instead compose the exported components with UiClient.
 * @experimental
 */
export function mountWebUI(root: HTMLElement, client: UiClient, options: WebUiOptions = {}): () => Promise<void> {
  if (options.authentication && options.initialToken !== undefined)
    throw new Error("authentication and initialToken cannot be combined");

  let state: UiClientState = client.state;
  let localError: string | null = null;
  const errorBox = element("div", "error-banner");
  errorBox.hidden = true;
  errorBox.setAttribute("role", "alert");
  const showError = (error: unknown) => {
    localError = error instanceof Error ? error.message : "操作失败。";
    errorBox.textContent = localError;
    errorBox.hidden = false;
  };
  const tasks = createUiTasks(showError);
  const act = (name: string, args: Record<string, string> = {}) => {
    tasks.run(client.command(name, args));
  };
  const pending = () => state.busy || state.selecting;
  const has = (name: string) => state.snapshot?.commands.includes(name) ?? false;

  const currentContext = (): WebUiContext => ({
    state,
    command: client.command.bind(client),
    readMedia: client.readMedia.bind(client),
  });

  const shell = element("div", "workbench");
  const sidebar = element("aside", "sidebar");
  sidebar.id = "may-sidebar";
  const brand = element("div", "brand");
  brand.append(
    element("span", "brand-mark", "m"),
    element("span", "brand-name", "May"),
    element("span", "preview-label", "PREVIEW"),
  );
  const closeSidebar = button("×", () => hideSidebar(), "icon-button sidebar-close");
  closeSidebar.setAttribute("aria-label", "关闭侧边栏");
  brand.append(closeSidebar);

  const newButton = button(
    "",
    () => {
      if (options.onNew) {
        try {
          const result = options.onNew(currentContext());
          if (result && typeof (result as Promise<void>).then === "function") {
            tasks.run(result as Promise<void>);
          }
        } catch (error) {
          showError(error);
        }
      } else if (state.snapshot?.product.resourceKind === "session") {
        act("session.new");
      } else {
        tasks.run(client.select().then(() => composer.textarea.focus()));
      }
      hideSidebar();
    },
    "new-button",
  );
  newButton.append(icon("plus"), element("span", "", options.newLabel ?? "新建"));
  const resources = createResourceList(client, root, tasks, {
    getState: () => state,
    pending,
    has,
    hideSidebar,
    onDeleted: (id) => composer.forget(id),
  });
  const navComponent = options.navigation
    ? createNavigation(options.navigation, currentContext, hideSidebar, showError)
    : undefined;
  const footer = element("div", "sidebar-footer");
  const connectionButton = button("连接本地服务", () => dialog.showModal(), "connection-button");
  const connectionDot = element("span", "connection-dot");
  connectionButton.prepend(connectionDot);
  footer.append(connectionButton, element("span", "local-label", "LOCAL WORKSPACE"));
  sidebar.append(
    brand,
    newButton,
    resources.searchLabel,
    resources.title,
    resources.list,
    resources.more,
    resources.info,
    ...(navComponent ? [navComponent.root] : []),
    footer,
  );

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
  const toggle = button(
    "",
    () => {
      const mobile = mobileQuery.matches;
      const isOpening = mobile
        ? !shell.classList.contains("sidebar-open")
        : shell.classList.contains("sidebar-collapsed");
      shell.classList.toggle(mobile ? "sidebar-open" : "sidebar-collapsed");
      syncSidebar();
      if (isOpening) {
        const candidates = sidebar.querySelectorAll<HTMLElement>(
          "button:not([disabled]), [tabindex='0']:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])",
        );
        const focusTarget =
          Array.from(candidates).find((el) => !el.closest("[hidden]") && el.offsetParent !== null) ?? candidates[0];
        focusTarget?.focus();
      }
    },
    "icon-button",
  );
  toggle.append(icon("menu"));
  toggle.setAttribute("aria-label", "切换侧边栏");
  toggle.setAttribute("aria-controls", sidebar.id);
  function syncSidebar(): void {
    const mobile = mobileQuery.matches;
    const isSidebarOpen = mobile
      ? shell.classList.contains("sidebar-open")
      : !shell.classList.contains("sidebar-collapsed");
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
  const headerLeft = element("div", "header-left");
  headerLeft.append(toggle, productName, productTag);
  const badges = element("div", "status-badges");
  badges.setAttribute("role", "status");
  headerLeft.append(badges);
  const versionUI = createWorkspaceUI(client);
  headerLeft.append(versionUI.status);
  const title = element("span", "current-title");
  const detailButton = button(
    "",
    () => {
      const isOpening = !shell.classList.contains("details-open");
      shell.classList.toggle("details-open");
      syncDetails();
      if (isOpening) {
        const focusTarget = details.querySelector<HTMLElement>("button, [tabindex='0'], input, select, textarea");
        focusTarget?.focus();
      }
    },
    "icon-button",
  );
  detailButton.append(icon("panel"));
  detailButton.setAttribute("aria-label", "显示或隐藏详情");
  detailButton.setAttribute("aria-expanded", "false");
  header.append(headerLeft, title, versionUI.actions, detailButton);
  const scroll = element("div", "conversation-scroll");
  const welcome = element("section", "welcome");
  const welcomeMark = element("div", "welcome-mark", "m");
  const welcomeTitle = element("h1", "", options.kind === "task" ? "把下一件事交给 May" : "从一个想法开始");
  const welcomeText = element("p", "", "连接本地服务，开始你的工作。");
  const suggestions = element("div", "suggestions");
  welcome.append(welcomeMark, welcomeTitle, welcomeText, suggestions);
  const messages = element("div", "messages");
  messages.setAttribute("aria-label", "对话记录");
  const approvals = element("div", "approvals");
  scroll.append(welcome, messages, approvals);

  const composer = createComposer(client, tasks, {
    getState: () => state,
    pending,
    has,
    act,
    submit: (text) => commandUI.submit(text),
  });
  main.append(header, errorBox, scroll, composer.area);
  const details = element("aside", "details-panel");
  details.setAttribute("aria-label", "详情");
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
  const inspector = createInspector(
    client,
    options.extensions ?? {},
    (open) => {
      workspaceDetails.hidden = open;
      if (open) {
        shell.classList.add("details-open");
        syncDetails();
      }
    },
    () => hideDetails(),
  );
  details.append(inspector.root, workspaceDetails);
  const reader = createTranscriptReader(
    client,
    { scroll, messages, approvals },
    options.extensions ?? {},
    (block) => inspector.inspect(block),
    showError,
    { fork: (point) => versionUI.fork(point), changes: (runId) => versionUI.changes(runId) },
  );
  const commandUI = createCommandUI(client, composer.textarea, (command) => {
    if (command === "/details") {
      reader.toggleDetails();
      return true;
    }
    if (command === "/thinking") {
      shell.classList.toggle("hide-reasoning");
      return true;
    }
    return false;
  });
  scroll.append(commandUI.root);
  composer.form.insertBefore(commandUI.suggestions, composer.textarea);
  main.insertBefore(reader.toolbar, scroll);
  shell.append(backdrop, sidebar, main, details);

  const dialog = createConnectionDialog(client, options, tasks);
  root.replaceChildren(shell, dialog, versionUI.dialog);

  let panelSignature = "",
    suggestionSignature = "";

  function render(next: UiClientState): void {
    state = next;
    const snapshot = state.snapshot,
      connected = state.connection === "connected";
    composer.select(snapshot?.selectedId ?? null);
    connectionButton.lastChild!.textContent = {
      connected: "已连接本地服务",
      connecting: "正在连接…",
      reconnecting: "连接中断，重连中…",
      disconnected: "连接本地服务",
    }[state.connection];
    connectionDot.className = `connection-dot ${state.connection}`;
    productName.textContent = snapshot?.product.title ?? options.title ?? "May";
    const isTask = (snapshot?.product.resourceKind ?? options.kind) === "task";
    productTag.textContent = isTask ? "任务" : "工作区";
    badges.replaceChildren(
      ...(snapshot?.badges ?? []).map((badge) =>
        element("span", `product-tag status-badge ${badge.tone === "warning" ? "warning" : "neutral"}`, badge.label),
      ),
    );
    header.classList.toggle("has-status-badges", Boolean(snapshot?.badges?.length));
    newButton.lastChild!.textContent = options.newLabel ?? (isTask ? "新建任务" : "新建会话");
    newButton.disabled = !connected || pending() || (!options.onNew && !has(isTask ? "task.submit" : "session.new"));
    const snapshotResources = snapshot?.resources ?? [];
    const snapshotMap = new Map(snapshotResources.map((r) => [r.id, r]));
    const active = snapshotMap.get(snapshot?.selectedId ?? "");
    title.textContent = active?.title ?? "";
    resources.refresh(isTask, composer.selected());
    navComponent?.update(state);
    const displayError = state.error ?? localError;
    errorBox.textContent = displayError ?? "";
    errorBox.hidden = !displayError;
    versionUI.update(state);
    inspector.update(state);
    reader.update(state);
    commandUI.update(state);
    const visibleBlocks = snapshot?.blocks ?? [];
    welcome.hidden = visibleBlocks.length > 0;
    welcomeTitle.textContent = isTask ? "把下一件事交给 May" : "今天，一起构建什么？";
    welcomeText.textContent =
      snapshot?.product.subtitle ?? "连接你的本地 Agent。对话、工具与执行状态，在同一个工作区。";
    const suggestionsKey = JSON.stringify(snapshot?.product.suggestions ?? []);
    if (suggestionsKey !== suggestionSignature) {
      suggestionSignature = suggestionsKey;
      suggestions.replaceChildren();
      for (const text of snapshot?.product.suggestions ?? []) {
        const suggestion = button("", () => composer.fill(text), "suggestion");
        suggestion.append(element("span", "", text), icon("arrow"));
        suggestions.append(suggestion);
      }
    }
    composer.update(isTask, connected);
    const panelsKey = JSON.stringify([snapshot?.panels, snapshot?.notice, snapshot?.commands, pending()]);
    if (panelsKey !== panelSignature) {
      panelSignature = panelsKey;
      workspaceDetails.replaceChildren();
      const detailsHeader = element("div", "details-header");
      detailsHeader.append(element("h2", "", "工作详情"), button("关闭", hideDetails, "text-button"));
      workspaceDetails.append(detailsHeader);
      for (const panel of snapshot?.panels ?? []) {
        const content =
          extensionContent(options.extensions?.panels?.[panel.id], panel, {
            state,
            command: client.command.bind(client),
          }) ?? detailPanel(panel);
        if (panel.actions?.length) {
          const actions = element("div", "detail-actions");
          for (const action of panel.actions) {
            const control = button(action.label, () => commandUI.perform(action));
            control.disabled = pending() || !has(action.command);
            actions.append(control);
          }
          content.append(actions);
        }
        workspaceDetails.append(content);
      }
      const actions = element("div", "detail-actions");
      for (const [command, label] of [
        ["context.compact", "压缩上下文"],
        ["task.recover", "核对恢复证据"],
        ["task.dispatch", "重新请求调度"],
      ])
        if (has(command!)) {
          const action = button(label!, () => act(command!));
          action.disabled = pending();
          actions.append(action);
        }
      if (has("session.rename"))
        actions.append(
          button("重命名会话", () => {
            const current = title.textContent ?? "";
            const rename = element("dialog", "connect-dialog");
            const renameForm = element("form");
            const input = element("input", "token-input");
            input.value = current;
            input.maxLength = 160;
            input.required = true;
            input.setAttribute("aria-label", "会话名称");
            const renameTitleId = "rename-session-title-" + Math.random().toString(36).slice(2, 9);
            rename.setAttribute("role", "dialog");
            rename.setAttribute("aria-modal", "true");
            rename.setAttribute("aria-labelledby", renameTitleId);
            const renameHeading = element("h2", "", "重命名会话");
            renameHeading.id = renameTitleId;
            const save = element("button", "button primary", "保存");
            save.type = "submit";
            renameForm.append(
              renameHeading,
              input,
              button("取消", () => rename.close()),
              save,
            );
            rename.append(renameForm);
            root.append(rename);
            renameForm.onsubmit = (event) => {
              event.preventDefault();
              act("session.rename", { title: input.value });
              rename.close();
            };
            rename.onclose = () => rename.remove();
            rename.showModal();
          }),
        );
      workspaceDetails.append(actions);
      if (snapshot?.notice) workspaceDetails.append(element("p", "detail-note", snapshot.notice));
    }
  }
  const keyboard = (event: KeyboardEvent) => {
    if (document.querySelector("dialog[open]")) return;
    if (event.key === "Tab" && mobileQuery.matches) {
      const panel = shell.classList.contains("sidebar-open")
        ? sidebar
        : shell.classList.contains("details-open")
          ? details
          : undefined;
      if (panel) {
        const controls = Array.from(
          panel.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [tabindex]"),
        ).filter(
          (control) =>
            control.tabIndex >= 0 &&
            !control.matches(":disabled") &&
            !control.closest("[hidden], [inert]") &&
            control.getClientRects().length > 0,
        );
        const first = controls[0],
          last = controls.at(-1);
        if (
          first &&
          last &&
          (!panel.contains(document.activeElement) ||
            (event.shiftKey ? document.activeElement === first : document.activeElement === last))
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      shell.classList.add("sidebar-open");
      shell.classList.remove("sidebar-collapsed");
      syncSidebar();
      resources.search.focus();
    }
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
  if (options.initialToken)
    tasks.run(
      options.initialToken
        .then((token) => {
          if (!disposed && token !== undefined) return client.connect(token);
        })
        .catch((error) => {
          if (!disposed) showError(error);
        }),
    );
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= (async () => {
      disposed = true;
      resources.dispose();
      const navigationClosed = navComponent?.dispose();
      const versionsClosed = versionUI.dispose();
      commandUI.dispose();
      const readerClosed = reader.dispose();
      const inspectorClosed = inspector.dispose();
      unsubscribe();
      const clientClosed = client.disconnect();
      document.removeEventListener("keydown", keyboard);
      mobileQuery.removeEventListener("change", onMobileChange);
      root.replaceChildren();
      const results = await Promise.allSettled([
        clientClosed,
        navigationClosed,
        versionsClosed,
        readerClosed,
        inspectorClosed,
        tasks.close(),
      ]);
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason as unknown);
      if (errors.length) throw new AggregateError(errors, "Web UI shutdown failed");
    })());
}
