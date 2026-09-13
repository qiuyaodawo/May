import { randomUUID } from "node:crypto";
import type { AgentApplicationEvent, AgentWorkspaceController } from "@may/application";
import { commandArgs, UiError, type UiCommand, type UiHost, type UiPanel, type UiProduct, type UiReceipt, type UiSnapshot, type UiChoice } from "./protocol.js";
import { UiProjection } from "./projection.js";

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
  async snapshot(): Promise<UiSnapshot> {
    const revision = this.revision, sessionId = this.app.sessionId;
    const history = await this.app.history();
    const resources = (await this.app.listSessions()).slice(0, 500).map(s => ({ id: s.id, kind: "session" as const, title: s.title ?? s.preview?.slice(0, 72) ?? "新会话", status: s.id === sessionId && this.app.isRunning ? "running" : "idle", updatedAt: s.lastUsedAt }));
    const projected = new UiProjection(); projected.history(history);
    // Durable completed blocks win; live deltas fill gaps until the checkpoint exists.
    for (const [id, block] of this.projection.blocks) if (!projected.blocks.has(id) || projected.blocks.get(id)?.status === "running") projected.blocks.set(id, block);
    const commands = this.app.isRunning ? ["run.cancel", "approval.resolve"] : ["message.submit", "session.new", "session.open", "session.rename", "context.compact", ...(this.options.commands ?? [])];
    if (this.fault) commands.length = 0;
    return { version: 1, hostId: this.hostId, revision, product: this.options.product, resources,
      selectedId: sessionId, blocks: [...projected.blocks.values()].slice(-500),
      interactions: [...projected.interactions.values()], commands,
      panels: [{ id: "workspace", title: "工作区", fields: [{ label: "目录", value: this.app.workspace }, { label: "会话", value: sessionId }, { label: "状态", value: this.app.isRunning ? "运行中" : "空闲" }] }, ...await this.options.panels?.() ?? []],
      choices: await this.options.choices?.() ?? [],
      notice: this.fault ?? "当前服务共享一个活动会话；切换会话会同步影响其它窗口。工具权限由宿主校验。",
    };
  }
  execute(command: UiCommand): Promise<UiReceipt> {
    const work = this.mutation.then(() => this.apply(command));
    this.mutation = work.catch(() => {}); return work;
  }
  private async apply(command: UiCommand): Promise<UiReceipt> {
    if (command.hostId !== this.hostId || command.targetId !== this.app.sessionId) throw new UiError(409, "活动会话已改变，请刷新后重试。");
    if (!(await this.snapshot()).commands.includes(command.name)) throw new UiError(409, "当前状态不允许此操作。");
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
        if (!await this.app.resolveApproval(command.args.id!, decision)) throw new UiError(409, "此审批已经结束或失效。");
        break;
      }
      case "session.new": commandArgs(command, []); await this.app.newSession(); this.projection = new UiProjection(); break;
      case "session.open": commandArgs(command, ["id"]); await this.app.resumeSession(command.args.id!); this.projection = new UiProjection(); break;
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
