import { randomUUID } from "node:crypto";
import type { AgentApplicationEvent, AgentWorkspaceController } from "@may/application";
import { commandArgs, UiError, type UiCommand, type UiHost, type UiPanel, type UiProduct, type UiReceipt, type UiSnapshot, type UiChoice, type UiPageRequest, type UiFieldRequest } from "./protocol.js";
import { UiProjection } from "./projection.js";
import { readPage, historyPage, recordedField, fieldPage, searchHistory } from "./reading.js";

export interface ApplicationUiOptions {
  readonly product: UiProduct;
  readonly panels?: () => Promise<readonly UiPanel[]>;
  readonly choices?: () => Promise<readonly UiChoice[]>;
  readonly commands?: readonly string[];
  readonly execute?: (command: UiCommand) => Promise<UiReceipt>;
}

type UiApplication = Omit<AgentWorkspaceController<{ type: string }>, "compactContext"> & {
  compactContext(): Promise<unknown>;
};

/** Adapter for a single-active-session workspace, shared by all connected operators. */
export class ApplicationUiHost implements UiHost {
  readonly hostId = randomUUID();
  private revision = 0;
  private projection = new UiProjection();
  private listeners = new Set<() => void>();
  private iterator: AsyncIterator<{ type: string }>;
  private relay: Promise<void>;
  private mutation: Promise<unknown> = Promise.resolve();
  private fault: string | undefined;
  constructor(private readonly app: UiApplication, private readonly options: ApplicationUiOptions) {
    this.iterator = app.events[Symbol.asyncIterator]();
    this.relay = this.consume().catch(() => { this.fault = "运行事件连接已停止。请检查宿主后重新启动。"; this.changed(); });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void { this.revision++; for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot stop the relay. */ } } }
  private async consume(): Promise<void> {
    while (true) {
      const next = await this.iterator.next(); if (next.done) return;
      if (next.value.type === "session.changed") this.projection = new UiProjection();
      else this.projection.event(next.value as AgentApplicationEvent);
      this.changed();
    }
  }
  snapshot(selectedId?: string): Promise<UiSnapshot> { return this.queuedSnapshot(selectedId); }
  private queuedSnapshot(selectedId?: string, all = false): Promise<UiSnapshot> {
    const work = this.mutation.then(() => this.buildSnapshot(selectedId, 0, all));
    this.mutation = work.catch(() => {}); return work;
  }
  private async buildSnapshot(selectedId?: string, attempt = 0, all = false): Promise<UiSnapshot> {
    const revision = this.revision, activeId = this.app.sessionId, running = this.app.isRunning;
    const viewingId = selectedId ?? activeId, viewingActive = viewingId === activeId;
    const sessions = await this.app.listSessions();
    if (!sessions.some(session => session.id === viewingId)) throw new UiError(404, "会话不存在或不属于当前工作区。");
    if (!viewingActive && !this.app.readSessionHistory) throw new UiError(409, "当前宿主不支持只读历史浏览。");
    const history = this.app.readSessionHistory ? await this.app.readSessionHistory(viewingId) : await this.app.history();
    // Keep the selected/active entries available even beyond the recent-resource limit.
    const visibleSessions = sessions.filter((session, index) => index < 500 || session.id === viewingId || session.id === activeId);
    const resources = visibleSessions.map(s => ({ id: s.id, kind: "session" as const, title: s.title ?? s.preview?.slice(0, 72) ?? "新会话", status: s.id === activeId && running ? "running" : "idle", updatedAt: s.lastUsedAt }));
    const projected = new UiProjection(Infinity); projected.history(history);
    if (viewingActive) {
      // Durable completed blocks win; only the execution owner's live deltas fill gaps.
      for (const [id, block] of this.projection.blocks) if (!projected.blocks.has(id) || ["running", "streaming", "awaiting-approval"].includes(projected.blocks.get(id)?.status ?? "")) projected.blocks.set(id, block);
    }
    if (!viewingActive || !running || this.fault) projected.settle();
    const interactions = viewingActive && running && !this.fault ? [...this.projection.interactions.values()] : [];
    const commands = this.app.readSessionHistory ? ["session.browse"] : [];
    if (!running) commands.push("session.new");
    if (viewingActive) commands.push(...(running ? ["run.cancel", ...(interactions.length ? ["approval.resolve"] : [])] : ["message.submit", "session.rename", "context.compact", ...(this.options.commands ?? [])]));
    else if (!running) commands.push("session.activate");
    if (this.fault) commands.length = 0;
    const panels = viewingActive ? await this.options.panels?.() ?? [] : [];
    const choices = viewingActive ? await this.options.choices?.() ?? [] : [];
    if (activeId !== this.app.sessionId || running !== this.app.isRunning) {
      if (attempt < 2) return this.buildSnapshot(viewingId, attempt + 1, all);
      throw new UiError(409, "运行会话状态已改变，请刷新后重试。");
    }
    const page = historyPage(this.hostId, viewingId, [...projected.blocks.values()]);
    return { version: 1, hostId: this.hostId, revision, product: this.options.product, resources,
      selectedId: viewingId, activeId, blocks: all ? [...projected.blocks.values()] : page.items,
      historyPage: { nextCursor: page.nextCursor, total: page.total }, reads: { resources: true, history: Boolean(this.app.readSessionHistory), fields: Boolean(this.app.readSessionHistory) },
      interactions, commands,
      panels: [{ id: "workspace", title: "工作区", fields: [{ label: "目录", value: this.app.workspace }, { label: "浏览会话", value: viewingId }, { label: "运行会话", value: activeId }, { label: "执行状态", value: running ? "运行中" : "空闲" }] }, ...panels],
      choices,
      notice: this.fault ?? "浏览只影响当前页面。设为运行会话或新建会话会更换宿主的执行对象，但不会切走其它页面；执行期间不能切换。",
    };
  }
  async resources(request: UiPageRequest) {
    const sessions = [...await this.app.listSessions()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    const items = sessions.map(s => ({ id: s.id, kind: "session" as const, title: s.title ?? s.preview?.slice(0, 72) ?? "新会话", status: s.id === this.app.sessionId && this.app.isRunning ? "running" : "idle", updatedAt: s.lastUsedAt }));
    return readPage(this.hostId, "resources", items, request, (item, query) => item.title.toLocaleLowerCase().includes(query));
  }
  async history(selectedId: string, request: UiPageRequest) {
    if (!this.app.readSessionHistory) throw new UiError(409, "宿主不支持只读历史。");
    return historyPage(this.hostId, selectedId, (await this.queuedSnapshot(selectedId, true)).blocks, request, searchHistory(await this.app.readSessionHistory(selectedId), request.query));
  }
  async field(selectedId: string, request: UiFieldRequest) {
    if (!this.app.readSessionHistory) throw new UiError(409, "宿主不支持只读详情。");
    const snapshot = await this.queuedSnapshot(selectedId, true), block = snapshot.blocks.find(b => b.id === request.blockId);
    if (!block) throw new UiError(404, "该记录不属于当前资源或已不可用。");
    const events = await this.app.readSessionHistory(selectedId);
    return fieldPage(this.hostId, selectedId, request, recordedField(events, block, request.field));
  }
  execute(command: UiCommand): Promise<UiReceipt> {
    const work = this.mutation.then(() => this.apply(command));
    this.mutation = work.catch(() => {}); return work;
  }
  private async apply(command: UiCommand): Promise<UiReceipt> {
    const transition = command.name === "session.activate" || command.name === "session.new";
    if (command.hostId !== this.hostId || !command.targetId || (transition ? command.expectedActiveId !== this.app.sessionId : command.targetId !== this.app.sessionId)) throw new UiError(409, "运行会话已改变，请检查当前状态后重试。");
    if (command.name === "session.browse" || !(await this.buildSnapshot(command.targetId)).commands.includes(command.name)) throw new UiError(409, "当前状态不允许此操作。");
    switch (command.name) {
      case "message.submit": {
        commandArgs(command, ["text"]);
        if (command.args.text!.length > 16_384) throw new UiError(400, "输入不能超过 16,384 个字符。");
        const run = await this.app.submit({ input: command.args.text!, inputId: `web:${command.requestId}` });
        void run.result.catch(() => {}).finally(() => this.changed());
        break;
      }
      case "run.cancel": commandArgs(command, []); this.app.cancel("Cancelled by operator"); break;
      case "approval.resolve": {
        commandArgs(command, ["id", "decision"]);
        const decision = command.args.decision;
        if (decision !== "allow" && decision !== "allow-session" && decision !== "deny") throw new UiError(400, "无效的审批决定。");
        const request = this.projection.interactions.get(command.args.id!);
        if (!request?.choices.some(choice => choice.value === decision)) throw new UiError(409, "审批已失效或该选项不可用。请刷新后检查。");
        if (!await this.app.resolveApproval(command.args.id!, decision)) throw new UiError(409, "此审批已经结束或失效。");
        break;
      }
      case "session.new": commandArgs(command, []); await this.app.newSession(); this.projection = new UiProjection(); break;
      case "session.activate": commandArgs(command, []); await this.app.resumeSession(command.targetId); this.projection = new UiProjection(); break;
      case "session.rename": commandArgs(command, ["title"]); await this.app.renameSession(this.app.sessionId, command.args.title!.slice(0, 160)); break;
      case "context.compact": commandArgs(command, []); await this.app.compactContext(); break;
      default: {
        if (!this.options.execute) throw new UiError(400, "命令没有实现。");
        const receipt = await this.options.execute(command); this.changed(); return receipt;
      }
    }
    this.changed(); return { selectedId: this.app.sessionId };
  }
  async close(): Promise<void> {
    await this.mutation.catch(() => {});
    await this.app.close(); await this.iterator.return?.(); await this.relay;
    this.listeners.clear();
  }
}
