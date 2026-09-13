import { randomUUID } from "node:crypto";
import { commandArgs, UiError, type UiCommand, type UiHost, type UiReceipt, type UiSnapshot } from "@may/ui-client";
import { UiProjection, displayValue } from "@may/ui-client/projection";
import type { MaybeClawHost } from "./host.js";
import { isTerminal } from "./types.js";

/** Task adapter: browsing a task never switches a Session or changes execution ownership. */
export class MaybeClawUiHost implements UiHost {
  readonly hostId = randomUUID();
  private revision = 0;
  private live = new Map<string, UiProjection>();
  private listeners = new Set<() => void>();
  private stop: () => void;
  constructor(private readonly host: MaybeClawHost) {
    this.stop = host.claw.observe((id, event) => {
      let projection = this.live.get(id);
      if (!projection) { projection = new UiProjection(); this.live.set(id, projection); }
      projection.event(event);
      while (this.live.size > 8) this.live.delete(this.live.keys().next().value!);
      this.revision++; for (const listener of this.listeners) listener();
    });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async snapshot(selectedId?: string): Promise<UiSnapshot> {
    const revision = ++this.revision;
    const tasks = await this.host.claw.store.list(), status = this.host.status();
    const selected = selectedId ? await this.host.claw.status(selectedId) : undefined;
    const task = selected?.task;
    const commands = ["task.submit"];
    if (task && !isTerminal(task) && !selected.cancellationRequested) commands.push("task.cancel");
    if (task && !selected.owner && ["running", "blocked"].includes(task.status)) commands.push("task.recover");
    if (task && task.status === "queued" && status.dispatchErrors[task.id]) commands.push("task.dispatch");
    const projection = task ? this.live.get(task.id) : undefined;
    return { version: 1, hostId: this.hostId, revision,
      product: { id: "maybeclaw", title: "MaybeClaw", resourceKind: "task", subtitle: "提交一个有明确结果的任务。离开页面后，工作仍由本地宿主继续。", suggestions: ["帮我制定一份学习计划", "梳理这个问题的关键假设", "把我的想法整理成行动清单"] },
      resources: [...tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 500).map(t => ({ id: t.id, kind: "task", title: t.spec.prompt.slice(0, 72), status: t.status, updatedAt: t.updatedAt })),
      selectedId: task?.id ?? null,
      blocks: task ? [
        { id: `input:${task.id}`, kind: "user", text: task.spec.prompt },
        ...(projection ? [...projection.blocks.values()].filter(block => !isTerminal(task) || block.kind === "tool") : []),
        ...(task.result === undefined ? [] : [{ id: `result:${task.id}`, kind: "assistant" as const, text: displayValue(task.result), status: "completed" }]),
        ...(task.detail ? [{ id: `detail:${task.id}`, kind: "notice" as const, text: task.detail }] : []),
        ...(!task.result && !projection?.blocks.size && !task.detail ? [{ id: `status:${task.id}`, kind: "notice" as const, text: selected.cancellationRequested ? "已请求取消，等待宿主确认。" : task.status === "queued" ? "任务已入队，等待宿主执行。" : "任务状态：" + task.status }] : []),
      ] : [],
      interactions: [], commands, choices: [],
      panels: [
        ...(task ? [{ id: "task", title: "任务详情", fields: [
          { label: "任务 ID", value: task.id }, { label: "执行状态", value: task.status }, { label: "验证状态", value: "尚未独立验证" },
          { label: "模型配置", value: task.spec.modelProfile }, { label: "读取范围", value: task.spec.readDirectory ?? "未授予文件读取权限" },
          { label: "取消请求", value: selected.cancellationRequested ? "已记录" : "无" },
          ...status.deliveries.filter(d => d.taskId === task.id).map(d => ({ label: `投递 · ${d.channel}`, value: d.status })),
          ...(status.dispatchErrors[task.id] ? [{ label: "调度错误", value: status.dispatchErrors[task.id]! }] : []),
        ] }] : []),
        { id: "host", title: "本地宿主", fields: [{ label: "状态", value: status.state }, { label: "执行槽位", value: `${status.active} / ${status.maxConcurrent}` }, ...status.channels.map(c => ({ label: c.name, value: c.state })), ...(status.error ? [{ label: "诊断", value: status.error }] : [])] },
        { id: "deliveries", title: "最近投递", fields: status.deliveries.map(d => ({ label: `${d.channel} · ${d.taskId?.slice(0, 8) ?? "回执"}`, value: d.status })) },
      ],
      notice: "执行完成不代表已验证或已送达。恢复只核对持久证据，不会重新执行已提交的工作。历史任务目前展示最终结果；实时工具详情只保留在当前宿主中。",
    };
  }
  async execute(command: UiCommand): Promise<UiReceipt> {
    if (command.hostId !== this.hostId) throw new UiError(409, "宿主已改变。");
    if (command.name === "task.submit") {
      commandArgs(command, ["text"]);
      if (command.targetId !== null || command.args.text!.length > 16_384) throw new UiError(400, "请新建任务后提交不超过 16,384 个字符的输入。");
      const result = await this.host.submit(command.args.text!, `ui:${command.hostId}:${command.requestId}`);
      return { selectedId: result.task.id };
    }
    if (!command.targetId) throw new UiError(400, "需要任务 ID。");
    const snapshot = await this.snapshot(command.targetId);
    if (!snapshot.commands.includes(command.name)) throw new UiError(409, "当前状态不允许此操作。");
    commandArgs(command, []);
    if (command.name === "task.cancel") await this.host.claw.cancel(command.targetId);
    else if (command.name === "task.recover") await this.host.claw.recover(command.targetId);
    else if (command.name === "task.dispatch") this.host.retryDispatch(command.targetId);
    else throw new UiError(400, "不支持的命令。");
    return { selectedId: command.targetId };
  }
  close(): void { this.stop(); this.live.clear(); this.listeners.clear(); }
}
