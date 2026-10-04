import { Keymap, type KeyStroke } from "@may/keybindings";
import type { InteractiveComponent, RenderResult, RenderSize } from "./component.js";
import { ListSelectionModel, printableKeyText } from "./list-selection.js";
import { Text, sanitizeTerminalText } from "./text.js";
import { DEFAULT_DARK_THEME, styleText, type TuiTheme } from "./theme.js";

export interface SessionForkPoint {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly createdAt: number;
  readonly userPreview: string;
  readonly assistantPreview: string;
  readonly available: boolean;
  readonly reason?: string;
  readonly parentPointId?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly worktreeAvailable?: boolean;
}

export interface SessionForkSelection {
  readonly pointId: string;
  readonly mode: "current" | "worktree";
}

interface TreeRow { readonly point: SessionForkPoint; readonly depth: number; readonly children: boolean }

/** 历史父子关系保留 Session 来源，可通过键盘浏览、搜索和预览。 */
export class SessionForkTree {
  private readonly rows: readonly TreeRow[];
  private readonly collapsed = new Set<string>();
  private readonly selection: ListSelectionModel<TreeRow>;
  constructor(points: readonly SessionForkPoint[], currentSessionId?: string) {
    const byId = new Map<string, SessionForkPoint>();
    for (const point of points) {
      if (byId.has(point.id)) throw new Error(`Duplicate history position: ${point.id}`);
      byId.set(point.id, point);
    }
    const children = new Map<string | undefined, SessionForkPoint[]>();
    for (const point of points) {
      const parent = point.parentPointId && byId.has(point.parentPointId) ? point.parentPointId : undefined;
      const siblings = children.get(parent) ?? []; siblings.push(point); children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const rows: TreeRow[] = [], visited = new Set<string>();
    const visit = (point: SessionForkPoint, depth: number) => {
      if (visited.has(point.id)) throw new Error(`Circular history relation: ${point.id}`);
      visited.add(point.id);
      const descendants = children.get(point.id) ?? [];
      rows.push({ point, depth, children: descendants.length > 0 });
      for (const descendant of descendants) visit(descendant, depth + 1);
    };
    for (const point of children.get(undefined) ?? []) visit(point, 0);
    if (visited.size !== points.length) throw new Error("History relations contain a cycle");
    this.rows = rows;
    const newest = rows.filter(row => row.point.available && (!currentSessionId || row.point.sessionId === currentSessionId)).sort((a, b) => b.point.createdAt - a.point.createdAt)[0];
    this.selection = new ListSelectionModel(rows, { initialIndex: newest ? rows.indexOf(newest) : 0, pageSize: 8, filter: (row, query) => [row.point.id, row.point.sessionId, row.point.userPreview, row.point.assistantPreview, row.point.branch, row.point.commit].some(value => value?.toLocaleLowerCase().includes(query)) });
  }
  get items() { return this.selection.items; }
  get selected() { return this.selection.selected?.point; }
  get selectedIndex() { return this.selection.selectedIndex; }
  get query() { return this.selection.query; }
  move(action: Parameters<ListSelectionModel<TreeRow>["move"]>[0]) { this.selection.move(action); }
  appendQuery(text: string) { this.selection.setItems(this.rows); this.selection.appendQuery(text); }
  backspaceQuery() { this.selection.backspaceQuery(); }
  clearQuery() { const preferred = this.selected?.id; this.selection.clearQuery(); this.refresh(preferred ?? ""); }
  isCollapsed(id: string) { return this.collapsed.has(id); }
  collapse() {
    const row = this.selection.selected;
    if (!row) return;
    if (row.children && !this.collapsed.has(row.point.id)) this.collapsed.add(row.point.id);
    else if (row.point.parentPointId) { this.refresh(row.point.parentPointId); return; }
    this.refresh(row.point.id);
  }
  expand() { const point = this.selected; if (point) { this.collapsed.delete(point.id); this.refresh(point.id); } }
  private select(id: string) { const index = this.items.findIndex(row => row.point.id === id); if (index < 0) return; this.selection.move("home"); for (let step = 0; step < index; step++) this.selection.move("down"); }
  private refresh(preferred: string) {
    let hiddenBelow: number | undefined;
    const visible = this.rows.filter(row => {
      if (hiddenBelow !== undefined && row.depth > hiddenBelow) return false;
      hiddenBelow = this.collapsed.has(row.point.id) ? row.depth : undefined; return true;
    });
    this.selection.setItems(this.query ? this.rows : visible); this.select(preferred);
  }
}

const bindings = [
  ["up", "up"], ["down", "down"], ["pageup", "page-up"], ["pagedown", "page-down"],
  ["home", "home"], ["end", "end"], ["left", "collapse"], ["right", "expand"],
  ["space", "preview"], ["/", "search"], ["enter", "accept"], ["escape", "cancel"], ["ctrl+c", "cancel"],
].map(([keys, action]) => ({ context: "fork", keys: keys!, action: action! }));

export class SessionForkPicker implements InteractiveComponent {
  readonly tree: SessionForkTree;
  private readonly keymap = new Keymap(bindings, { actions: bindings.map(binding => binding.action) });
  private mode: "history" | "search" | "workspace" = "history";
  private workspaceIndex = 0;
  private preview = false;
  private previewOffset = 0;
  private previewPageSize = 5;
  private previewLength = 0;
  private notice = "";
  constructor(points: readonly SessionForkPoint[], private readonly options: { readonly currentSessionId?: string; readonly theme?: TuiTheme; readonly onComplete: (selection?: SessionForkSelection) => void }) {
    this.tree = new SessionForkTree(points, options.currentSessionId);
  }
  handleKey(stroke: KeyStroke): boolean {
    const action = this.keymap.resolve(stroke, ["fork"]);
    const value = action.type === "action" ? action.action : undefined;
    if (this.mode === "search") {
      if (stroke.key === "escape") { this.tree.clearQuery(); this.mode = "history"; }
      else if (stroke.key === "enter") this.mode = "history";
      else if (stroke.key === "backspace") this.tree.backspaceQuery();
      else if (stroke.ctrl && stroke.key === "u") this.tree.clearQuery();
      else if (value === "up" || value === "down" || value === "page-up" || value === "page-down") this.tree.move(value);
      else if (stroke.ctrl && stroke.key === "c") this.options.onComplete();
      else { const text = printableKeyText(stroke); if (text) this.tree.appendQuery(text); }
      return true;
    }
    if (value === "cancel") { if (this.mode === "workspace" && !stroke.ctrl) this.mode = "history"; else this.options.onComplete(); return true; }
    if (this.mode === "workspace") {
      if (value === "up" || value === "down" || value === "collapse" || value === "expand") this.workspaceIndex = 1 - this.workspaceIndex;
      if (value === "accept") {
        const point = this.tree.selected;
        if (point && (this.workspaceIndex === 0 || point.worktreeAvailable)) this.options.onComplete({ pointId: point.id, mode: this.workspaceIndex === 0 ? "current" : "worktree" });
      }
      return true;
    }
    if (this.preview && (value === "page-up" || value === "page-down")) this.previewOffset = Math.max(0, Math.min(Math.max(0, this.previewLength - this.previewPageSize), this.previewOffset + (value === "page-up" ? -this.previewPageSize : this.previewPageSize)));
    else if (value === "up" || value === "down" || value === "page-up" || value === "page-down" || value === "home" || value === "end") { this.tree.move(value); this.previewOffset = 0; }
    else if (value === "collapse") this.tree.collapse();
    else if (value === "expand") this.tree.expand();
    else if (value === "preview") { this.preview = !this.preview; this.previewOffset = 0; }
    else if (value === "search") this.mode = "search";
    else if (value === "accept") {
      const point = this.tree.selected;
      if (point?.available) { this.mode = "workspace"; this.workspaceIndex = 0; this.notice = ""; }
      else this.notice = point?.reason ?? "该历史位置无法恢复。";
    }
    return true;
  }
  render(size: RenderSize): RenderResult {
    const theme = this.options.theme ?? DEFAULT_DARK_THEME;
    const selected = this.tree.selected;
    if (this.mode === "workspace") return new Text([
      "选择分支工作区", "", `${this.workspaceIndex === 0 ? "▸" : " "} 当前工作区`, "  保留当前文件内容和 Git branch。",
      `${this.workspaceIndex === 1 ? "▸" : " "} 新建 worktree${selected?.worktreeAvailable ? "" : "（文件版本不可用）"}`,
      `  使用历史 commit ${selected?.commit?.slice(0, 12) ?? "不可用"}。`, "", "↑↓ 选择 · Enter 创建 · Esc 返回",
    ].join("\n")).render(size);
    const previewBudget = this.preview ? Math.max(0, Math.min(9, Math.floor(size.height / 2))) : 0;
    const budget = Math.max(1, size.height - previewBudget - 4);
    const start = Math.floor(this.tree.selectedIndex / budget) * budget;
    const lines = this.tree.items.slice(start, start + budget).map((row, offset) => {
      const point = row.point;
      const marker = row.children ? this.tree.isCollapsed(point.id) ? "▸" : "▾" : "·";
      const label = sanitizeTerminalText(point.userPreview).replace(/\s+/gu, " ");
      return styleText(`${start + offset === this.tree.selectedIndex ? "▸" : " "} ${"  ".repeat(Math.min(row.depth, 8))}${marker} ${new Date(point.createdAt).toLocaleString()} · ${label} · ${point.commit?.slice(0, 8) ?? "无文件版本"}${point.available ? "" : " · 无法恢复"}`, start + offset === this.tree.selectedIndex ? theme.accent : theme.text);
    });
    if (!lines.length) lines.push("没有匹配的历史位置。");
    lines.unshift(`历史位置${this.tree.query ? ` · 搜索：${sanitizeTerminalText(this.tree.query)}` : ""}`, "");
    if (previewBudget && selected) {
      const previewLines = new Text(`Session ${sanitizeTerminalText(selected.sessionId)}\n请求：${sanitizeTerminalText(selected.userPreview)}\n回复：${sanitizeTerminalText(selected.assistantPreview)}\n版本：${sanitizeTerminalText(selected.branch ?? "")} ${selected.commit?.slice(0, 12) ?? "不可用"}`).render({ width: size.width, height: 100_000 }).lines;
      this.previewLength = previewLines.length; this.previewPageSize = Math.max(1, previewBudget - 1);
      lines.push("", ...previewLines.slice(this.previewOffset, this.previewOffset + this.previewPageSize));
    }
    if (this.notice) lines.push(styleText(sanitizeTerminalText(this.notice), theme.warning));
    lines.push("", this.mode === "search" ? "输入搜索内容 · Enter 完成 · Esc 清除搜索" : `↑↓ 选择 · ←→ 展开或收起 · / 搜索 · Space 预览${this.preview ? " · PgUp/PgDn 预览翻页" : ""} · Enter 继续 · Esc 取消`);
    return new Text(lines.join("\n"), { wrap: false }).render(size);
  }
}
