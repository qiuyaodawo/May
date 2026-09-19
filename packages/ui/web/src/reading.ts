import type { UiBlock, UiClient, UiClientState, UiField, UiFieldPage } from "@may/ui-client";
import { approvalCard, button, element, statusLabel, transcriptBlock, type WebUiExtensions } from "./components.js";

const preview = (text: string, limit: number) => text.length > limit ? text.slice(0, limit) + "\n…（预览已截断，完整内容见详情）" : text;
const exceptional = (block: UiBlock) => ["failed", "unknown", "interrupted", "denied", "cancelled", "not-started", "awaiting-approval"].includes(block.status ?? "");
function unique(blocks: readonly UiBlock[]): UiBlock[] { return [...new Map(blocks.map(block => [block.id, block])).values()]; }

/** View-local reading state. No selection, cancellation or execution commands are issued here. */
export function createTranscriptReader(client: UiClient, elements: { scroll: HTMLElement; messages: HTMLElement; approvals: HTMLElement }, extensions: WebUiExtensions, inspect: (block: UiBlock) => void) {
  const { scroll, messages, approvals } = elements;
  const toolbar = element("div", "reading-toolbar"); toolbar.setAttribute("aria-label", "执行过程阅读");
  const summary = element("span", "reading-summary"); summary.setAttribute("aria-live", "polite");
  const onlyErrors = element("input"); onlyErrors.type = "checkbox";
  const errorLabel = element("label", "reading-filter"); errorLabel.append(onlyErrors, document.createTextNode("只看异常"));
  const jumpApproval = button("定位待审批", () => { following = false; approvals.scrollIntoView({ block: "start" }); approvals.querySelector("button")?.focus(); });
  const latest = button("回到最新", () => { following = true; unread = false; pinBottom(); updateControls(); }); latest.hidden = true;
  toolbar.append(summary, button("展开全部", () => expand(true)), button("收起全部", () => expand(false)), errorLabel, jumpApproval, latest);
  const historyControls = element("div", "history-controls");
  const searchForm = element("form", "history-search");
  const search = element("input"); search.type = "search"; search.maxLength = 256; search.placeholder = "搜索当前会话或任务的内容"; search.setAttribute("aria-label", "搜索历史内容");
  const submit = element("button", "button", "搜索内容"); submit.type = "submit";
  searchForm.append(search, submit, button("清除搜索", () => { search.value = ""; void loadHistory(false); }));
  const more = button("加载更早记录", () => { void loadHistory(true); });
  const info = element("span", "history-info"); info.setAttribute("role", "status");
  historyControls.append(searchForm, more, info); scroll.prepend(historyControls);
  let state = client.state, scope = "", disposed = false, requestId = 0, loading = false;
  let older: UiBlock[] = [], results: UiBlock[] | null = null, query = "", cursor: string | null = null, total = 0;
  let following = true, restoring = false, unread = false, lastTail = "", defaultExpanded = false;
  const toolOpen = new Map<string, boolean>(), groupClosed = new Set<string>();
  const nodes = new Map<string, { signature: string; node: HTMLElement }>();
  const groups = new Map<string, { root: HTMLElement; header: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement }>();
  let visible: UiBlock[] = [];
  function pinBottom() { restoring = true; scroll.scrollTop = scroll.scrollHeight; requestAnimationFrame(() => { restoring = false; }); }
  scroll.addEventListener("scroll", () => { if (!restoring) { following = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80; if (following) unread = false; updateControls(); } });
  function updateControls() {
    more.hidden = !state.snapshot?.reads?.history || !cursor;
    more.disabled = loading || state.connection !== "connected" || state.selecting;
    more.textContent = query ? "加载更多匹配记录" : "加载更早记录";
    submit.disabled = loading || !state.snapshot?.selectedId || state.connection !== "connected" || state.selecting;
    searchForm.hidden = !state.snapshot?.reads?.history;
    latest.hidden = following || !state.snapshot?.blocks.length;
    latest.textContent = unread ? "有新内容 · 回到最新" : "回到最新";
    jumpApproval.hidden = !state.snapshot?.interactions.length;
    jumpApproval.textContent = `定位待审批（${state.snapshot?.interactions.length ?? 0}）`;
  }
  async function loadHistory(append: boolean) {
    const requestedQuery = search.value.trim(), id = ++requestId, selection = scope;
    loading = true; info.textContent = "正在读取…"; updateControls();
    try {
      const page = await client.readHistory(requestedQuery, append ? cursor ?? undefined : undefined);
      if (disposed || id !== requestId || selection !== scope) return;
      query = requestedQuery; cursor = page.nextCursor; total = page.total;
      if (query) results = unique([...page.items, ...(append ? results ?? [] : [])]);
      else { results = null; older = append ? unique([...page.items, ...older, ...(state.snapshot?.blocks ?? [])]) : [...page.items]; }
      following = false; render();
      info.textContent = query ? `匹配 ${total} 条 · 搜索结果只读，重新搜索可刷新` : `已加载 ${visible.length} / ${total} 条`;
    } catch (error) { if (id === requestId && selection === scope) info.textContent = error instanceof Error ? error.message : "读取失败；可重新搜索或重试。"; }
    finally { if (id === requestId) { loading = false; updateControls(); } }
  }
  searchForm.onsubmit = event => { event.preventDefault(); void loadHistory(false); };
  onlyErrors.onchange = () => { following = false; render(); };
  function expand(value: boolean) {
    following = false; defaultExpanded = value;
    for (const block of visible) if (block.kind === "tool") toolOpen.set(block.id, value);
    if (value) groupClosed.clear(); else for (const key of groups.keys()) groupClosed.add(key);
    render();
  }
  function render() {
    const snapshot = state.snapshot;
    const top = scroll.getBoundingClientRect().top;
    const anchor = [...messages.querySelectorAll<HTMLElement>("article[data-id]")].find(node => !node.closest("[hidden]") && node.getBoundingClientRect().bottom > top && node.getBoundingClientRect().top < scroll.getBoundingClientRect().bottom);
    const offset = anchor?.getBoundingClientRect().top, oldTop = scroll.scrollTop;
    visible = results ?? unique([...older, ...(snapshot?.blocks ?? [])]);
    const tail = JSON.stringify([snapshot?.blocks.at(-1), snapshot?.interactions]);
    if (lastTail && lastTail !== tail && !following) unread = true;
    lastTail = tail;
    const tools = visible.filter(b => b.kind === "tool");
    summary.textContent = `已载入 ${tools.length} 次工具调用 · 运行中 ${tools.filter(b => b.status === "running").length} · 待审批 ${snapshot?.interactions.length ?? 0} · 异常 ${tools.filter(b => exceptional(b) && b.status !== "awaiting-approval").length}`;
    const grouped = new Map<string, UiBlock[]>(); let last = "unassigned";
    for (const block of visible) {
      const key = block.runId ?? (block.kind === "user" ? `request:${block.id}` : last);
      last = key; const list = grouped.get(key) ?? []; list.push(block); grouped.set(key, list);
    }
    const activeIds = new Set<string>(); let groupIndex = 0;
    for (const [key, list] of grouped) {
      if (onlyErrors.checked && !list.some(exceptional)) continue;
      let group = groups.get(key);
      if (!group) {
        const root = element("section", "run-group"), header = element("div", "run-heading"), body = element("div", "run-body");
        const toggle = button("", () => { following = false; if (groupClosed.has(key)) groupClosed.delete(key); else groupClosed.add(key); render(); }, "text-button run-toggle");
        header.append(toggle); root.append(header, body); group = { root, header, body, toggle }; groups.set(key, group);
      }
      const title = list.find(b => b.kind === "user")?.text.slice(0, 48) || (key === "unassigned" ? "任务记录" : `运行 ${key}`);
      const groupTools = list.filter(b => b.kind === "tool");
      const waiting = snapshot?.interactions.filter(request => request.runId === key).length ?? 0;
      const failures = groupTools.filter(b => exceptional(b) && b.status !== "awaiting-approval").length;
      const caption = `${groupClosed.has(key) ? "展开" : "收起"} · ${title} · ${groupTools.length} 次工具调用${waiting ? ` · 待审批 ${waiting}` : ""}${failures ? ` · 异常 ${failures}` : ""}`;
      if (group.toggle.textContent !== caption) group.toggle.textContent = caption;
      group.toggle.setAttribute("aria-expanded", String(!groupClosed.has(key))); group.body.hidden = groupClosed.has(key);
      if (messages.children[groupIndex] !== group.root) messages.insertBefore(group.root, messages.children[groupIndex] ?? null); groupIndex++;
      let index = 0;
      for (const block of list) {
        if (onlyErrors.checked && block.kind !== "user" && !exceptional(block)) continue;
        activeIds.add(block.id);
        const signature = JSON.stringify([block, state.connection, state.busy, state.selecting, snapshot?.commands]);
        let entry = nodes.get(block.id);
        if (!entry || entry.signature !== signature) {
          // Keep transcripts compact; full evidence and product renderers live in the inspector.
          const { presentation: _presentation, ...withoutPresentation } = block;
          const compact: UiBlock = block.kind === "tool" ? { ...withoutPresentation, input: preview(block.input ?? "", 400), text: preview(block.text, 800), ...(block.diagnostic ? { diagnostic: { ...block.diagnostic, message: preview(block.diagnostic.message, 800) } } : {}) } : block;
          const node = transcriptBlock(compact, block.kind === "tool" ? {} : extensions, { state, command: client.command.bind(client) });
          if (block.kind === "tool") {
            const details = node.querySelector("details")!;
            details.open = toolOpen.get(block.id) ?? defaultExpanded;
            details.addEventListener("toggle", () => { if (details.isConnected && nodes.get(block.id)?.node === node) toolOpen.set(block.id, details.open); });
            details.querySelector("summary")!.addEventListener("click", () => { following = false; });
          }
          if (block.kind === "tool" || block.text.length > 1200 || block.diagnostic) {
            const action = button("查看详情", () => inspect(block), "text-button inspect-tool"); action.setAttribute("aria-label", `查看 ${block.title ?? (block.kind === "tool" ? "工具" : block.kind === "assistant" ? "回答" : "记录")} 详情`); node.append(action);
          }
          if (entry) entry.node.replaceWith(node); entry = { signature, node }; nodes.set(block.id, entry);
        }
        if (block.kind === "tool") entry.node.querySelector("details")!.open = toolOpen.get(block.id) ?? defaultExpanded;
        if (group.body.children[index] !== entry.node) group.body.insertBefore(entry.node, group.body.children[index] ?? null); index++;
      }
    }
    for (const [id, entry] of nodes) if (!activeIds.has(id)) { entry.node.remove(); nodes.delete(id); }
    for (const [key, group] of groups) if (!grouped.has(key) || onlyErrors.checked && !grouped.get(key)!.some(exceptional)) { group.root.remove(); groups.delete(key); }
    const approvalsKey = JSON.stringify([snapshot?.interactions, state.connection, state.busy, state.selecting, snapshot?.commands]);
    if (approvals.dataset.signature !== approvalsKey) {
      approvals.dataset.signature = approvalsKey;
      approvals.replaceChildren(...(snapshot?.interactions ?? []).map(request => approvalCard(request, decision => {
        void client.command("approval.resolve", { id: request.id, decision }).catch(() => {});
      }, state.connection !== "connected" || state.busy || state.selecting || !snapshot?.commands.includes("approval.resolve"), extensions, { state, command: client.command.bind(client) })));
    }
    restoring = true;
    if (following && !query) scroll.scrollTop = scroll.scrollHeight;
    else if (anchor?.isConnected && offset !== undefined) scroll.scrollTop += anchor.getBoundingClientRect().top - offset;
    else scroll.scrollTop = oldTop;
    requestAnimationFrame(() => { restoring = false; }); updateControls();
  }
  return { toolbar, toggleDetails: () => expand(!defaultExpanded),
    update(next: UiClientState) {
      state = next; const nextScope = `${next.snapshot?.hostId ?? ""}:${next.snapshot?.selectedId ?? ""}`;
      if (scope !== nextScope) {
        scope = nextScope; requestId++; loading = false; older = []; results = null; query = ""; search.value = ""; info.textContent = "";
        cursor = next.snapshot?.historyPage?.nextCursor ?? null; following = true; unread = false; lastTail = "";
        toolOpen.clear(); groupClosed.clear(); nodes.clear(); groups.clear(); messages.replaceChildren();
      } else if (!older.length && results === null) cursor = next.snapshot?.historyPage?.nextCursor ?? null;
      if (older.length && results === null) older = unique([...older, ...(next.snapshot?.blocks ?? [])]);
      total = next.snapshot?.historyPage?.total ?? next.snapshot?.blocks.length ?? 0;
      render();
    },
    dispose() { disposed = true; requestId++; },
  };
}

/** Dedicated, read-only evidence panel. A chunk version prevents mixing changed output. */
export function createInspector(client: UiClient, extensions: WebUiExtensions, visibility: (open: boolean) => void) {
  const root = element("div", "evidence-inspector"); root.hidden = true;
  let state = client.state, scope = "", selected: UiBlock | undefined, field: UiField | "overview" = "overview", requestId = 0, page: UiFieldPage | undefined;
  let offsets: number[] = [], disposed = false, loading = false;
  function render() {
    root.replaceChildren(); if (!selected) return;
    const header = element("div", "details-header"); header.append(element("h2", "", selected.title ?? "记录详情"), button("返回工作详情", () => close(), "text-button")); root.append(header);
    root.append(element("p", "detail-note", `只读详情 · ${statusLabel(selected.status ?? "unknown")} · 不执行工具或审批`));
    const tabs = element("div", "detail-tabs");
    const fields: [UiField | "overview", string][] = [["overview", "概览"], ["input", "输入"], ["text", "输出"], ["diagnostic", "错误"], ["presentation", "展示 / Diff"]];
    for (const [key, label] of fields) {
      const tab = button(label, () => { requestId++; loading = false; field = key; page = undefined; offsets = []; if (key === "overview") render(); else void load(0); });
      tab.setAttribute("aria-pressed", String(key === field)); tab.disabled = key !== "overview" && !state.snapshot?.reads?.fields; tabs.append(tab);
    }
    root.append(tabs);
    if (field === "overview") {
      const node = transcriptBlock(selected, extensions, { state, command: client.command.bind(client) });
      const details = node.querySelector("details"); if (details) details.open = true; root.append(node);
    } else {
      const content = element("pre", "tool-content field-content", page?.text ?? "正在读取…"); content.setAttribute("aria-label", "记录字段内容"); root.append(content);
      const controls = element("div", "field-controls");
      controls.append(button("从首段刷新", () => { offsets = []; page = undefined; void load(0); }));
      const previous = button("上一段", () => { const offset = offsets.pop(); if (offset !== undefined) void load(offset); }); previous.disabled = loading || !offsets.length;
      const next = button("下一段", () => { if (page?.nextOffset !== null && page?.nextOffset !== undefined) { offsets.push(page.offset); void load(page.nextOffset); } }); next.disabled = loading || !page || page.nextOffset === null;
      controls.append(previous, next); root.append(controls);
      if (page) root.append(element("p", "detail-note", `${page.total ? page.offset + 1 : 0}–${page.offset + page.text.length} / ${page.total} 字符 · 每段最多 32,768 字符`));
    }
  }
  async function load(offset: number) {
    if (!selected || field === "overview") return;
    const id = ++requestId, key = scope;
    loading = true; render();
    try {
      const result = await client.readField(selected.id, field, offset, offset ? page?.version : undefined);
      if (disposed || id !== requestId || key !== scope) return;
      page = result; loading = false; render();
    } catch (error) { if (id === requestId && key === scope) { loading = false; render(); root.append(element("p", "dialog-error", error instanceof Error ? error.message : "读取失败，请从首段刷新。")); } }
  }
  function close() { requestId++; selected = undefined; page = undefined; root.hidden = true; visibility(false); }
  return { root, close,
    inspect(block: UiBlock) { requestId++; selected = block; field = "overview"; page = undefined; offsets = []; root.hidden = false; visibility(true); render(); },
    update(next: UiClientState) {
      const key = `${next.snapshot?.hostId ?? ""}:${next.snapshot?.selectedId ?? ""}`;
      if (scope !== key) { scope = key; close(); }
      state = next;
      const current = selected && next.snapshot?.blocks.find(b => b.id === selected!.id);
      if (current && JSON.stringify(current) !== JSON.stringify(selected)) { selected = current; if (field === "overview") render(); }
    },
    dispose() { disposed = true; requestId++; },
  };
}
