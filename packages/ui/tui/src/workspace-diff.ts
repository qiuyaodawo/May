import type { KeyStroke } from "@may/keybindings";
import type { InteractiveComponent, RenderResult, RenderSize } from "./component.js";
import { renderDiff } from "./agent/tool-renderers.js";
import { ListSelectionModel, printableKeyText, removeLastCodePoint } from "./list-selection.js";
import { Text, sanitizeTerminalText } from "./text.js";
import { DEFAULT_DARK_THEME, styleText, type TuiTheme } from "./theme.js";

export interface WorkspaceDiffFile {
  readonly path: string;
  readonly status: string;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}
export interface WorkspaceDiff {
  readonly runId?: string;
  readonly restorePreviewId?: string;
  readonly title: string;
  readonly from?: string;
  readonly to?: string;
  readonly uncommitted: boolean;
  readonly files: readonly WorkspaceDiffFile[];
}

/** 文件列表与 unified diff 使用相同的工具变化颜色，保留键盘滚动和搜索。 */
export class WorkspaceDiffViewer implements InteractiveComponent {
  private readonly selection: ListSelectionModel<WorkspaceDiffFile>;
  private mode: "files" | "patch" | "search" = "files";
  private offset = 0;
  private pageSize = 10;
  private query = "";
  private notice = "";
  private pending: Promise<void> = Promise.resolve();
  private busy = false;
  constructor(private diff: WorkspaceDiff, private readonly options: { readonly theme?: TuiTheme; readonly onClose: () => void; readonly onRestore?: (path: string) => Promise<WorkspaceDiff>; readonly onApply?: (previewId: string) => Promise<void>; readonly onInvalidate?: () => void }) {
    this.selection = new ListSelectionModel(diff.files, { pageSize: 10 });
  }
  get selectedFile() { return this.selection.selected; }
  get scrollOffset() { return this.offset; }
  waitForPending(): Promise<void> { return this.pending; }
  handleKey(stroke: KeyStroke): boolean {
    if (this.busy) return true;
    if (stroke.ctrl && stroke.key === "c") { this.options.onClose(); return true; }
    const commandKey = !stroke.ctrl && !stroke.alt && !stroke.meta;
    if (commandKey && this.mode !== "search" && this.diff.restorePreviewId && stroke.key === "y" && this.options.onApply) {
      this.perform(async () => { await this.options.onApply!(this.diff.restorePreviewId!); this.options.onClose(); });
      return true;
    }
    if (commandKey && this.mode !== "search" && stroke.key === "r" && !this.diff.restorePreviewId && this.selection.selected && this.options.onRestore) {
      const path = this.selection.selected.path;
      this.perform(async () => { this.diff = await this.options.onRestore!(path); this.selection.setItems(this.diff.files); this.selection.move("home"); this.mode = "patch"; this.offset = 0; this.query = ""; });
      return true;
    }
    if (this.mode === "search") {
      if (stroke.key === "escape") { this.mode = "patch"; this.query = ""; }
      else if (stroke.key === "enter") { this.mode = "patch"; this.find(false); }
      else if (stroke.key === "backspace") this.query = removeLastCodePoint(this.query);
      else if (stroke.ctrl && stroke.key === "u") this.query = "";
      else { const text = printableKeyText(stroke); if (text) this.query += text; }
      return true;
    }
    if (stroke.key === "escape") { if (this.mode === "patch") { this.mode = "files"; this.offset = 0; } else this.options.onClose(); return true; }
    if (this.mode === "files") {
      const action = navigation(stroke.key);
      if (action) this.selection.move(action);
      if (stroke.key === "enter" && this.selection.selected) { this.mode = "patch"; this.offset = 0; this.query = ""; }
      return true;
    }
    const file = this.selection.selected;
    const lines = file?.patch.split("\n") ?? [];
    const maximum = Math.max(0, lines.length - this.pageSize);
    if (stroke.key === "up") this.offset = Math.max(0, this.offset - 1);
    else if (stroke.key === "down") this.offset = Math.min(maximum, this.offset + 1);
    else if (stroke.key === "pageup") this.offset = Math.max(0, this.offset - this.pageSize);
    else if (stroke.key === "pagedown") this.offset = Math.min(maximum, this.offset + this.pageSize);
    else if (stroke.key === "home") this.offset = 0;
    else if (stroke.key === "end") this.offset = maximum;
    else if (stroke.key === "/" || stroke.text === "/") this.mode = "search";
    else if (stroke.key === "n") this.find(true);
    else if (stroke.key === "]" || stroke.text === "]") {
      const changes = lines.flatMap((line, index) => line.startsWith("@@") ? [index] : []);
      this.offset = changes.find(index => index > this.offset) ?? changes[0] ?? this.offset;
    }
    return true;
  }
  render(size: RenderSize): RenderResult {
    const theme = this.options.theme ?? DEFAULT_DARK_THEME;
    this.pageSize = Math.max(1, size.height - 5);
    const totals = this.diff.files.reduce((value, file) => ({ additions: value.additions + file.additions, deletions: value.deletions + file.deletions }), { additions: 0, deletions: 0 });
    const header = [sanitizeTerminalText(this.diff.title), `${this.diff.from?.slice(0, 12) ?? "初始版本"} → ${this.diff.uncommitted ? "当前未提交变化" : this.diff.to?.slice(0, 12) ?? "目标版本"} · ${this.diff.files.length} 个文件 · +${totals.additions} -${totals.deletions}`, ""];
    let body: string[];
    if (this.mode === "files") {
      const start = Math.floor(this.selection.selectedIndex / this.pageSize) * this.pageSize;
      body = this.diff.files.slice(start, start + this.pageSize).map((file, index) => styleText(`${start + index === this.selection.selectedIndex ? "▸" : " "} ${sanitizeTerminalText(file.path)} · ${file.status} · ${file.binary ? "二进制文件" : `+${file.additions} -${file.deletions}`}`, start + index === this.selection.selectedIndex ? theme.accent : theme.text));
      if (!body.length) body.push("没有文件变化。");
    } else {
      const file = this.selection.selected;
      body = file?.binary ? ["二进制文件无法显示文本 diff。"] : renderDiff(file?.patch ?? "", theme).slice(this.offset, this.offset + this.pageSize).map(line => line.value);
      header[2] = `${sanitizeTerminalText(file?.path ?? "")} · 第 ${this.offset + 1} 行`;
    }
    const footer = this.diff.restorePreviewId ? "恢复预览 · Y 确认恢复文件 · Esc 返回或取消" : this.mode === "files" ? `↑↓ 选择文件 · Enter 查看 diff${this.options.onRestore ? " · R 预览恢复" : ""} · Esc 关闭` : this.mode === "search" ? `搜索：${sanitizeTerminalText(this.query)} · Enter 查找 · Esc 取消` : `↑↓ 滚动 · PgUp/PgDn 翻页 · / 搜索 · N 下一处匹配 · ] 下一处修改${this.options.onRestore ? " · R 预览恢复" : ""} · Esc 文件列表`;
    return new Text([...header, ...body, footer, this.busy ? "正在处理文件版本…" : sanitizeTerminalText(this.notice)].join("\n"), { wrap: false }).render(size);
  }
  private find(next: boolean) {
    if (!this.query) return;
    const lines = this.selection.selected?.patch.split("\n") ?? [];
    const matches = lines.flatMap((line, index) => line.toLocaleLowerCase().includes(this.query.toLocaleLowerCase()) ? [index] : []);
    const target = (next ? matches.find(index => index > this.offset) : undefined) ?? matches[0];
    if (target === undefined) this.notice = "没有匹配的内容。";
    else { this.offset = target; this.notice = ""; }
  }
  private perform(work: () => Promise<void>) {
    this.busy = true;
    this.pending = work().catch(error => { this.notice = error instanceof Error ? error.message : "文件版本操作失败。"; }).finally(() => { this.busy = false; this.options.onInvalidate?.(); });
    this.options.onInvalidate?.();
  }
}

function navigation(key: string): "up" | "down" | "page-up" | "page-down" | "home" | "end" | undefined {
  if (key === "up" || key === "down" || key === "home" || key === "end") return key;
  if (key === "pageup") return "page-up";
  if (key === "pagedown") return "page-down";
  return undefined;
}

export function workspaceGitLabel(workspace: { readonly status: string; readonly branch?: string; readonly detached?: boolean; readonly commit?: string; readonly autoCommit?: boolean; readonly error?: string }): string {
  if (workspace.status === "error") return `Git 错误${workspace.error ? `：${sanitizeTerminalText(workspace.error)}` : ""}`;
  if (workspace.status === "initializing") return "Git 初始化中";
  const version = workspace.detached ? `detached HEAD · ${workspace.commit?.slice(0, 12) ?? "无 commit"}` : workspace.branch ?? "Git 尚无 commit";
  return sanitizeTerminalText(`${version}${workspace.autoCommit === false ? " · 自动提交关闭" : ""}`);
}
