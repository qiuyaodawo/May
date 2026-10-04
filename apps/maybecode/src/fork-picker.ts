import type { UiForkPoint, UiWorkspaceDiff } from "@may/ui-client";
import { SessionForkPicker, WorkspaceDiffViewer, sanitizeTerminalText, type InteractiveComponent, type SessionForkSelection } from "@may/tui";
import type { TerminalIO } from "@may/tui/node-terminal";
import type { MaybeCodeController } from "./controller.js";

export async function runForkPicker(options: { readonly points: readonly UiForkPoint[]; readonly currentSessionId: string; readonly terminal: TerminalIO; readonly question: (prompt: string) => Promise<string> }): Promise<SessionForkSelection | undefined> {
  if (!options.points.length) { options.terminal.write("\n没有可选择的完整回复。\n"); return undefined; }
  if (!options.terminal.interactive || !options.terminal.readKey || !options.terminal.renderView || !options.terminal.closeView) {
    for (const [index, point] of options.points.entries()) options.terminal.write(sanitizeTerminalText(`\n${index + 1}. ${point.userPreview} · ${point.commit?.slice(0, 12) ?? "无文件版本"}${point.available ? "" : ` · ${point.reason ?? "无法恢复"}`}\n`));
    const answer = (await options.question("选择历史位置编号，直接回车取消：")).trim();
    if (!answer) return undefined;
    const point = options.points[Number(answer) - 1];
    if (!point?.available) throw new Error(point?.reason ?? "历史位置不可用。");
    const mode = (await options.question("选择工作区：1 当前工作区；2 新建 worktree；直接回车取消：")).trim();
    if (!mode) return undefined;
    if (mode !== "1" && mode !== "2") throw new Error("工作区选择无效。");
    if (mode === "2" && !point.worktreeAvailable) throw new Error("历史文件版本不可用于创建 worktree。");
    return { pointId: point.id, mode: mode === "1" ? "current" : "worktree" };
  }
  let result: SessionForkSelection | undefined, complete = false;
  const picker = new SessionForkPicker(options.points, { currentSessionId: options.currentSessionId, onComplete: selection => { result = selection; complete = true; } });
  await runView(options.terminal, picker, () => complete);
  return result;
}

export async function runChangesPicker(terminal: TerminalIO, diff: UiWorkspaceDiff, app?: MaybeCodeController): Promise<void> {
  if (!terminal.interactive || !terminal.readKey || !terminal.renderView || !terminal.closeView) {
    terminal.write(sanitizeTerminalText(`\n${diff.title}\n${diff.uncommitted ? "当前未提交变化" : `${diff.from ?? ""} → ${diff.to ?? ""}`}\n`));
    for (const file of diff.files) terminal.write(sanitizeTerminalText(`\n${file.path} · ${file.status} · ${file.binary ? "二进制文件" : `+${file.additions} -${file.deletions}\n${file.patch}`}\n`));
    return;
  }
  let complete = false;
  const viewer = new WorkspaceDiffViewer(diff, { onClose: () => { complete = true; },
    ...(diff.runId && app?.previewRestore ? { onRestore: async (path: string) => (await app.previewRestore!(diff.runId!, [path])).diff } : {}),
    ...(app?.restoreFiles ? { onApply: (previewId: string) => app.restoreFiles!(previewId) } : {}),
  });
  try { while (!complete) { terminal.renderView!(viewer.render({ width: 100, height: 30 }).lines.join("\n")); viewer.handleKey(await terminal.readKey!()); await viewer.waitForPending(); } }
  finally { terminal.closeView!(); }
}

async function runView(terminal: TerminalIO, view: InteractiveComponent, complete: () => boolean) {
  try { while (!complete()) { terminal.renderView!(view.render({ width: 100, height: 30 }).lines.join("\n")); view.handleKey(await terminal.readKey!()); } }
  finally { terminal.closeView!(); }
}
