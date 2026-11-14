import type { UiClient, UiClientState, UiResource } from "@sortedyuan/ui-client";
import { button, element, icon, statusLabel } from "./components.js";
import type { createUiTasks } from "./tasks.js";

export function createResourceList(
  client: UiClient,
  root: HTMLElement,
  tasks: ReturnType<typeof createUiTasks>,
  host: {
    readonly getState: () => UiClientState;
    readonly pending: () => boolean;
    readonly has: (name: string) => boolean;
    readonly hideSidebar: () => void;
    readonly onDeleted: (id: string) => void;
  },
) {
  const { pending, has, hideSidebar } = host;
  const searchLabel = element("label", "search-field");
  searchLabel.append(icon("search"));
  const search = element("input");
  search.type = "search";
  search.placeholder = "搜索历史";
  search.setAttribute("aria-label", "搜索会话或任务");
  searchLabel.append(search);
  const listTitle = element("div", "sidebar-label", "最近记录");
  const list = element("nav", "resource-list");
  list.setAttribute("aria-label", "会话与任务");
  const resourceMore = button("加载更多记录", () => {
    tasks.run(loadResources(true));
  });
  resourceMore.hidden = true;
  const resourceInfo = element("p", "list-empty");
  resourceInfo.setAttribute("role", "status");

  let listSignature = "";
  let resourceItems: UiResource[] | null = null,
    resourceCursor: string | null = null,
    resourceRequest = 0,
    resourceHost = "";
  let resourceVersion = "",
    resourcePages = 1;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  async function loadResources(append = false) {
    const state = host.getState();
    if (!state.snapshot?.reads?.resources) {
      renderList();
      return;
    }
    if (append && !resourceCursor) return;
    const id = ++resourceRequest,
      hostId = state.snapshot.hostId,
      query = search.value.trim();
    resourceInfo.textContent = "正在读取…";
    resourceMore.disabled = true;
    try {
      const items = append ? [...(resourceItems ?? [])] : [];
      let cursor = append ? resourceCursor : null,
        pages = append ? resourcePages : 0,
        total = 0;
      const count = append ? 1 : resourcePages;
      for (let index = 0; index < count; index++) {
        const page = await client.readResources(query, cursor ?? undefined);
        if (id !== resourceRequest || hostId !== host.getState().snapshot?.hostId || query !== search.value.trim())
          return;
        items.push(...page.items);
        cursor = page.nextCursor;
        total = page.total;
        pages++;
        if (!cursor) break;
      }
      resourceItems = [...new Map(items.map((item) => [item.id, item])).values()];
      resourcePages = pages;
      resourceCursor = cursor;
      resourceInfo.textContent = resourceItems.length < total ? `已加载 ${resourceItems.length} / ${total} 条` : "";
      renderList();
    } catch (error) {
      if (id === resourceRequest)
        resourceInfo.textContent = error instanceof Error ? error.message : "读取失败，请重试搜索。";
    } finally {
      if (id === resourceRequest) {
        resourceMore.disabled = false;
        resourceMore.hidden = !resourceCursor;
      }
    }
  }

  function deleteSession(resource: UiResource): void {
    const state = host.getState();
    const hostId = state.snapshot?.hostId,
      currentId = state.snapshot?.activeId;
    const confirmation = element("dialog", "connect-dialog"),
      form = element("form");
    const titleId = "delete-session-title-" + Math.random().toString(36).slice(2, 9);
    confirmation.setAttribute("role", "dialog");
    confirmation.setAttribute("aria-modal", "true");
    confirmation.setAttribute("aria-labelledby", titleId);
    const heading = element("h2", "", "删除会话");
    heading.id = titleId;
    const error = element("p", "dialog-error");
    error.setAttribute("role", "alert");
    const remove = element("button", "button primary", "删除会话");
    remove.type = "submit";
    form.append(
      heading,
      element("p", "", `确定删除“${resource.title}”及其历史记录？此操作无法撤销。`),
      error,
      button("取消", () => confirmation.close()),
      remove,
    );
    confirmation.append(form);
    root.append(confirmation);
    form.onsubmit = (event) => {
      event.preventDefault();
      const state = host.getState();
      if (state.snapshot?.hostId !== hostId || state.snapshot?.activeId !== currentId) {
        error.textContent = "当前会话已改变，请关闭后重新选择删除操作。";
        return;
      }
      remove.disabled = true;
      tasks.run(
        client.command("session.delete", {}, resource.id).then(
          () => {
            host.onDeleted(resource.id);
            confirmation.close();
          },
          (reason) => {
            error.textContent = reason instanceof Error ? reason.message : "删除失败。";
            remove.disabled = false;
          },
        ),
      );
    };
    confirmation.onclose = () => confirmation.remove();
    confirmation.showModal();
  }

  function renderList(): void {
    const state = host.getState();
    const snapshot = state.snapshot,
      query = search.value.trim().toLocaleLowerCase();
    const snapshotResources = snapshot?.resources ?? [];
    const snapshotMap = new Map(snapshotResources.map((r) => [r.id, r]));
    const resources =
      resourceItems === null
        ? query
          ? snapshotResources.filter((r) => r.title.toLocaleLowerCase().includes(query))
          : [...snapshotResources]
        : resourceItems.map((item) => snapshotMap.get(item.id) ?? item);
    if (!query && snapshot?.selectedId && !resources.some((item) => item.id === snapshot.selectedId)) {
      const selectedResource = snapshotMap.get(snapshot.selectedId);
      if (selectedResource) resources.unshift(selectedResource);
    }
    list.replaceChildren();
    for (const resource of resources) {
      const row = element("div", "resource-row");
      const item = button(
        "",
        () => {
          tasks.run(client.select(resource.id));
          hideSidebar();
        },
        `resource-item${resource.id === snapshot?.selectedId ? " selected" : ""}`,
      );
      item.disabled =
        pending() ||
        state.connection !== "connected" ||
        (snapshot?.product.resourceKind === "session" && !has("session.activate") && resource.id !== snapshot.activeId);
      if (resource.id === snapshot?.selectedId) item.setAttribute("aria-current", "page");
      item.append(icon(resource.kind === "task" ? "task" : "code"), element("span", "resource-title", resource.title));
      if (resource.status !== "idle")
        item.append(element("span", `resource-status ${resource.status}`, statusLabel(resource.status)));
      item.title = resource.title;
      row.append(item);
      if (resource.kind === "session" && resource.id !== snapshot?.activeId) {
        const remove = button("", () => deleteSession(resource), "resource-delete icon-button");
        remove.append(icon("trash"));
        remove.title = "删除会话";
        remove.setAttribute("aria-label", `删除会话：${resource.title}`);
        remove.disabled = pending() || state.connection !== "connected" || !has("session.delete");
        row.append(remove);
      }
      list.append(row);
    }
    if (!resources.length)
      list.append(
        element("p", "list-empty", query ? "没有匹配的记录" : snapshot ? "你的工作会保存在这里" : "连接后查看历史记录"),
      );
  }

  search.maxLength = 256;
  search.oninput = () => {
    clearTimeout(searchTimer);
    resourceRequest++;
    resourceItems = null;
    resourceCursor = null;
    resourcePages = 1;
    if (!host.getState().snapshot?.reads?.resources) renderList();
    else {
      resourceItems = [];
      renderList();
      searchTimer = setTimeout(() => {
        tasks.run(loadResources());
      }, 250);
    }
  };

  return {
    searchLabel,
    search,
    title: listTitle,
    list,
    more: resourceMore,
    info: resourceInfo,
    refresh(isTask: boolean, selected: string | null): void {
      const state = host.getState();
      const snapshot = state.snapshot,
        connected = state.connection === "connected";
      listTitle.textContent = isTask ? "最近任务" : "最近会话";
      const snapshotResources = snapshot?.resources ?? [];
      const nextResourceVersion =
        snapshot?.resourcesVersion ??
        `${snapshotResources.length}:${snapshotResources[0]?.id ?? ""}:${snapshotResources[0]?.title ?? ""}`;
      const changedHost = resourceHost !== (snapshot?.hostId ?? "");
      if (changedHost) {
        resourceHost = snapshot?.hostId ?? "";
        resourceRequest++;
        resourceItems = null;
        resourceCursor = null;
        resourceInfo.textContent = "";
        resourceMore.hidden = true;
        resourcePages = 1;
      }
      if (changedHost || resourceVersion !== nextResourceVersion) {
        resourceVersion = nextResourceVersion;
        clearTimeout(searchTimer);
        if (snapshot?.reads?.resources) tasks.run(loadResources());
      }
      const sig = JSON.stringify([
        snapshot?.resources,
        selected,
        snapshot?.activeId,
        pending(),
        snapshot?.commands,
        connected,
      ]);
      if (sig !== listSignature) {
        listSignature = sig;
        renderList();
      }
    },
    dispose(): void {
      resourceRequest++;
      clearTimeout(searchTimer);
    },
  };
}
