import type { UiClient, UiClientState, UiForkPoint, UiWorkspaceDiff } from "@may/ui-client";
import { button, element } from "./components.js";

/** 工作区版本信息和分支入口使用宿主提供的结构化状态。 */
export function createWorkspaceUI(client: UiClient) {
  const status = element("span", "workspace-git-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-label", "当前 Git branch");
  const actions = element("div", "workspace-version-actions");
  const changes = button("查看文件变化", () => viewChanges("session"), "text-button");
  const worktrees = button("管理 worktree", () => openWorktrees(), "text-button");
  actions.append(changes, worktrees);
  const dialog = element("dialog", "workspace-dialog");
  dialog.setAttribute("aria-label", "工作区版本与分支");
  const content = element("div");
  const error = element("p", "dialog-error"); error.setAttribute("role", "alert");
  const close = button("关闭", () => dialog.close());
  dialog.append(content, error, close);
  let state = client.state, diff: UiWorkspaceDiff | null | undefined;
  let selectedFile = 0, searchText = "", patchScroll: HTMLElement | undefined;
  let forkPointId: string | undefined;
  let mode: "fork" | "diff" | "worktrees" | undefined;
  let signature = "";
  const report = (value: unknown) => { error.textContent = value instanceof Error ? value.message : "操作失败。"; };
  const ready = (name: string) => state.connection === "connected" && !state.busy && !state.selecting && Boolean(state.snapshot?.commands.includes(name));
  function show(nextMode: typeof mode) { mode = nextMode; error.textContent = ""; if (!dialog.open) dialog.showModal(); }
  function renderFork() {
    const point = state.snapshot?.forkPoints?.find(item => item.id === forkPointId);
    content.replaceChildren(element("h2", "", "创建 Session 分支"));
    if (!point) { content.append(element("p", "", "历史位置已不可用，请关闭后重新选择。")); return; }
    content.append(element("p", "", new Date(point.createdAt).toLocaleString()), element("pre", "fork-preview", point.userPreview), element("pre", "fork-preview", point.assistantPreview));
    if (point.branch || point.commit) content.append(element("p", "checkpoint-version", [point.branch, point.commit?.slice(0, 12)].filter(Boolean).join(" · ")));
    if (!point.available) content.append(element("p", "dialog-error", point.reason ?? "该历史位置无法恢复。"));
    const current = button("当前工作区", () => fork("current"));
    current.disabled = !point.available || !ready("session.fork");
    const separate = button("新建 worktree", () => fork("worktree"));
    separate.disabled = !point.available || !point.worktreeAvailable || !ready("session.fork");
    content.append(element("p", "", "当前工作区保留现有文件与 Git branch；新建 worktree 使用该回复关联的 commit。"), current, separate);
    if (!point.worktreeAvailable) content.append(element("p", "detail-note", "该位置没有可用于创建 worktree 的文件版本。"));
  }
  async function fork(workspaceMode: "current" | "worktree") {
    if (!forkPointId) return;
    try { await client.command("session.fork", { pointId: forkPointId, mode: workspaceMode }); dialog.close(); }
    catch (value) { report(value); }
  }
  function viewChanges(scope: "run" | "session" | "workspace", runId?: string) {
    show("diff"); content.replaceChildren(element("p", "", "正在读取文件变化…"));
    void client.command("changes.view", { scope, ...(runId ? { runId } : {}) }).then(() => {
      if (!client.state.diff) content.replaceChildren(element("p", "", "宿主未提供文件变化。"));
    }, report);
  }
  function renderDiff() {
    patchScroll = undefined;
    content.replaceChildren();
    if (!diff) return;
    content.append(element("h2", "", diff.title), element("p", "checkpoint-version", `${diff.from?.slice(0, 12) ?? "初始版本"} → ${diff.uncommitted ? "当前未提交变化" : diff.to?.slice(0, 12) ?? "目标版本"}`));
    const scopes = element("div", "diff-scopes");
    for (const [scope, label] of [["session", "整个 Session"], ["workspace", "当前工作区"]] as const) {
      const action = button(label, () => viewChanges(scope)); action.disabled = !ready("changes.view"); scopes.append(action);
    }
    content.append(scopes);
    if (diff.restorePreviewId) {
      const previewId = diff.restorePreviewId;
      const apply = button("确认恢复文件", () => { void client.command("changes.restore.apply", { previewId }).then(() => dialog.close(), report); }, "button primary");
      apply.disabled = !ready("changes.restore.apply");
      content.append(element("p", "detail-note", "确认后将使用预览的历史文件内容。宿主会再次检查当前文件是否发生变化。"), apply);
    }
    const total = diff.files.reduce((result, file) => ({ additions: result.additions + file.additions, deletions: result.deletions + file.deletions }), { additions: 0, deletions: 0 });
    content.append(element("p", "diff-summary", `${diff.files.length} 个文件 · +${total.additions} -${total.deletions}`));
    if (!diff.files.length) { content.append(element("p", "", "没有文件变化。")); return; }
    const list = element("div", "diff-files"); list.setAttribute("role", "list");
    for (const [index, file] of diff.files.entries()) {
      const item = button(`${file.path} · ${file.status} · ${file.binary ? "二进制文件" : `+${file.additions} -${file.deletions}`}`, () => { selectedFile = index; renderDiff(); }, "text-button");
      item.setAttribute("aria-pressed", String(index === selectedFile)); list.append(item);
      if (diff.runId && !diff.restorePreviewId && state.snapshot?.commands.includes("changes.restore.preview")) {
        const runId = diff.runId;
        const restore = button(`预览恢复 ${file.path}`, () => { void client.command("changes.restore.preview", { runId, path: file.path }).catch(report); }, "text-button");
        restore.disabled = !ready("changes.restore.preview"); list.append(restore);
      }
    }
    content.append(list);
    const file = diff.files[selectedFile] ?? diff.files[0]!;
    if (file.binary) { content.append(element("p", "", "二进制文件无法显示文本 diff。")); return; }
    const search = element("input"); search.type = "search"; search.value = searchText; search.setAttribute("aria-label", "搜索 diff 内容");
    search.oninput = () => { searchText = search.value; findLine(false); };
    const navigation = element("div", "diff-navigation"); navigation.append(search, button("下一处匹配", () => findLine(true)), button("下一处修改", () => nextChange())); content.append(navigation);
    patchScroll = element("pre", "workspace-patch"); patchScroll.tabIndex = 0; patchScroll.setAttribute("aria-label", `${file.path} unified diff`);
    for (const line of file.patch.split("\n")) {
      const row = element("span", line.startsWith("+") ? "diff-added" : line.startsWith("-") ? "diff-removed" : line.startsWith("@@") ? "diff-hunk" : "diff-context", line);
      patchScroll.append(row);
    }
    content.append(patchScroll);
    if (searchText) findLine(false);
  }
  function findLine(next: boolean) {
    if (!patchScroll) return;
    const lines = [...patchScroll.children] as HTMLElement[];
    const current = lines.findIndex(line => line.classList.contains("diff-match"));
    for (const line of lines) line.classList.remove("diff-match");
    if (!searchText) return;
    const matching = lines.map((line, index) => ({ line, index })).filter(item => item.line.textContent?.toLocaleLowerCase().includes(searchText.toLocaleLowerCase()));
    const target = (next ? matching.find(item => item.index > current) : undefined) ?? matching[0];
    target?.line.classList.add("diff-match"); target?.line.scrollIntoView({ block: "nearest" });
  }
  function nextChange() {
    if (!patchScroll) return;
    const lines = [...patchScroll.querySelectorAll<HTMLElement>(".diff-hunk")];
    const current = lines.findIndex(line => line.classList.contains("diff-current-hunk"));
    for (const line of lines) line.classList.remove("diff-current-hunk");
    const target = lines[(current + 1) % lines.length]; target?.classList.add("diff-current-hunk"); target?.scrollIntoView({ block: "nearest" });
  }
  function openWorktrees() { show("worktrees"); renderWorktrees(); }
  function renderWorktrees() {
    content.replaceChildren(element("h2", "", "管理 worktree"));
    const items = state.snapshot?.worktrees ?? [];
    if (!items.length) content.append(element("p", "", "没有已登记的 worktree。"));
    for (const item of items) {
      const section = element("section", "worktree-entry");
      section.append(element("h3", "", item.branch), element("p", "", item.path), element("p", "", `${item.status} · ${item.commit.slice(0, 12)}`));
      if (item.error) section.append(element("p", "dialog-error", item.error));
      const open = button("打开", () => { void client.command("worktree.open", { id: item.id }).then(() => dialog.close(), report); });
      open.disabled = !ready("worktree.open") || item.status !== "ready";
      const remove = button("删除 worktree", () => {
        if (!confirm(`删除 worktree ${item.path}？宿主将检查关联会话、进程及需要保留的修改。`)) return;
        void client.command("worktree.delete", { id: item.id }).then(renderWorktrees, report);
      }); remove.disabled = !ready("worktree.delete"); section.append(open, remove); content.append(section);
    }
  }
  return { status, actions, dialog,
    fork(point: UiForkPoint) { forkPointId = point.id; show("fork"); renderFork(); },
    changes(runId: string) { viewChanges("run", runId); },
    update(next: UiClientState) {
      const previous = state.snapshot;
      state = next;
      if (previous && (previous.hostId !== state.snapshot?.hostId || previous.selectedId !== state.snapshot?.selectedId)) {
        if (dialog.open) dialog.close();
        mode = undefined; forkPointId = undefined; patchScroll = undefined;
        error.textContent = ""; content.replaceChildren();
      }
      const workspace = state.snapshot?.workspace;
      status.hidden = !workspace;
      status.textContent = !workspace ? "" : workspace.status === "error" ? "Git 状态读取失败" : workspace.status === "initializing" ? "Git 初始化中" : workspace.detached ? `detached HEAD · ${workspace.commit?.slice(0, 12) ?? "无 commit"}` : workspace.branch ?? "Git 尚无 commit";
      status.title = workspace?.error ?? workspace?.path ?? "";
      status.dataset.status = workspace?.status ?? "";
      actions.hidden = !workspace;
      changes.disabled = !ready("changes.view");
      worktrees.hidden = state.snapshot?.worktrees === undefined;
      worktrees.disabled = state.connection !== "connected" || state.busy || state.selecting;
      if (state.diff !== diff) { diff = state.diff; selectedFile = 0; searchText = ""; if (diff) { show("diff"); renderDiff(); } }
      const nextSignature = JSON.stringify([state.busy, state.selecting, state.connection, state.snapshot?.forkPoints, state.snapshot?.worktrees, state.snapshot?.commands]);
      if (signature !== nextSignature) { signature = nextSignature; if (dialog.open && mode === "fork") renderFork(); else if (dialog.open && mode === "worktrees") renderWorktrees(); else if (dialog.open && mode === "diff" && diff) renderDiff(); }
    },
    dispose() { dialog.remove(); },
  };
}
