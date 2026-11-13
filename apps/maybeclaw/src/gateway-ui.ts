import { randomUUID } from "node:crypto";
import {
  UiError,
  type UiBlock,
  type UiCommand,
  type UiFieldRequest,
  type UiHost,
  type UiPageRequest,
  type UiReceipt,
  type UiSnapshot,
} from "@sortedyuan/ui-client";
import { historyPage, readPage, fieldPage } from "@sortedyuan/ui-client/reading";
import { UiProjection } from "@sortedyuan/ui-client/projection";
import { displayParts, imageAttachment, readEmbeddedImage } from "@sortedyuan/media";
import type { GatewayController } from "./gateway-api.js";
import type { GatewaySession } from "./gateway-types.js";
import { actorKey, digest } from "./gateway-types.js";
import { controlActor, executeGatewayUiCommand } from "./gateway-ui-commands.js";

export { controlActor } from "./gateway-ui-commands.js";

export class GatewayUiHost implements UiHost {
  readonly hostId = randomUUID();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  constructor(
    readonly gateway: GatewayController,
    readonly hostStatus: () => unknown = () => gateway.status(),
  ) {
    this.unsubscribe = gateway.observe(() => {
      this.revision++;
      for (const listener of this.listeners) listener();
    });
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  async snapshot(selectedId?: string, all = false): Promise<UiSnapshot> {
    const session = selectedId ? this.gateway.session(selectedId, controlActor) : undefined;
    const persistentRules = this.gateway.configuration(controlActor).persistentRules;
    const tasks = session ? this.gateway.tasks(controlActor, session.id) : [];
    const approvals = session ? this.gateway.approvals(controlActor, session.id) : [];
    const blocks = session ? this.blocks(session) : [];
    const page = historyPage(this.hostId, selectedId ?? "", blocks);
    const resources = this.resourceList();
    const commands = [
      "session.new",
      "session.create",
      "session.activate",
      "gateway.command",
      "gateway.inspect",
      "agent.save",
      "agent.delete",
      "agent.check",
      "approval.resolve",
      "delivery.retry",
    ];
    if (persistentRules) commands.push("permission.rule.create", "permission.rule.revoke");
    if (session)
      commands.push(
        "session.rename",
        "session.archive",
        "session.restore",
        "session.delete",
        "session.default",
        "session.bind",
        "session.admins",
        "agent.default",
        "agent.allow",
        "session.diagnostics",
      );
    if (session?.status === "active") commands.push("message.submit", "run.cancel");
    return {
      version: 1,
      hostId: this.hostId,
      revision: ++this.revision,
      product: {
        id: "maybeclaw",
        title: "MaybeClaw",
        resourceKind: "session",
        subtitle: "管理会话，并通过 Gateway 使用与协作多个 Agent。",
        suggestions: [],
      },
      resources: resources.slice(0, 500),
      resourcesVersion: digest(resources),
      selectedId: selectedId ?? null,
      blocks: all ? blocks : page.items,
      historyPage: { nextCursor: page.nextCursor, total: page.total },
      reads: { resources: true, history: true, fields: true },
      commands,
      choices: [],
      controls: {
        inputCommand: "gateway.command",
        responseCommand: "approval.resolve",
        cancelCommand: "run.cancel",
        busy: tasks.some((task) => ["queued", "running", "waiting", "cancelling"].includes(task.status)),
        forms: [],
      },
      interactions: approvals
        .filter((item) => item.status === "pending" && item.expiresAt > Date.now())
        .map((item) => ({
          id: item.id,
          kind: "approval",
          title: `${item.agentId} · ${item.kind === "tool" ? "工具审批" : "创建 Agent 对话"}`,
          detail: item.text,
          blockId: `approval:${item.id}`,
          runId: item.taskId ?? "",
          toolCallId: item.requestId,
          toolName: item.agentId,
          choices: [
            { value: "allow", label: "允许本次" },
            ...(item.grantKey ? [{ value: "allow-session", label: "允许该 Agent 对话中的同类操作" }] : []),
            ...(item.persistent && persistentRules ? [{ value: "allow-persistent", label: "保存持久允许规则" }] : []),
            { value: "deny", label: "拒绝" },
          ],
        })),
      panels: [
        {
          id: "agents",
          title: "已配置 Agent",
          fields: this.gateway
            .status()
            .agents.map((agent) => ({ label: agent.id, value: `${agent.name} · ${agent.status}` })),
        },
        ...(session
          ? [
              {
                id: "session",
                title: "会话",
                fields: [
                  { label: "会话 ID", value: session.id },
                  { label: "状态", value: session.status },
                  { label: "默认 Agent", value: session.defaultAgents.join(", ") },
                  { label: "可用 Agent", value: session.allowedAgents.join(", ") },
                  { label: "聊天入口", value: session.entry ? JSON.stringify(session.entry) : "控制端会话" },
                  ...this.gateway.bindings(controlActor, session.id).map((binding) => ({
                    label: binding.agentId,
                    value: `${binding.status} · ${binding.conversationId ?? binding.error ?? "尚无对话 ID"}`,
                  })),
                ],
              },
            ]
          : []),
        {
          id: "tasks",
          title: "执行",
          fields: tasks.map((task) => ({
            label: `${task.agentId} · ${task.id}`,
            value: `${task.status} · graph ${task.graphId} · task ${task.graphTaskId}${task.detail ? ` · ${task.detail}` : ""}`,
          })),
        },
        ...(session
          ? [
              {
                id: "telemetry",
                title: "执行诊断",
                fields: [],
                actions: [{ label: "查询当前会话", command: "session.diagnostics", args: {} }],
              },
            ]
          : []),
        {
          id: "deliveries",
          title: "消息投递",
          fields: (session ? this.gateway.deliveries(controlActor, session.id) : []).map((item) => ({
            label: `${item.entry.account} · ${item.id}`,
            value: item.status,
          })),
        },
        {
          id: "host",
          title: "服务状态",
          fields: [{ label: "Gateway", value: JSON.stringify(this.hostStatus(), null, 2) }],
        },
        ...(persistentRules
          ? [
              {
                id: "permission-rules",
                title: "持久权限规则",
                fields: [],
                actions: [{ label: "查看和管理规则", command: "gateway.inspect", args: { kind: "permission-rules" } }],
              },
            ]
          : []),
      ],
      notice: "浏览页面只改变当前窗口。入口默认会话通过会话管理中的明确操作修改。",
    };
  }

  private resourceList() {
    return this.gateway
      .sessions(controlActor)
      .map((session) => ({
        id: session.id,
        kind: "session" as const,
        title: session.name,
        status: session.status,
        updatedAt: session.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  private blocks(session: GatewaySession): UiBlock[] {
    const times = new Map<string, number>();
    const messages: UiBlock[] = this.gateway.messages(session.id, controlActor).map((message) => ({
      id: message.id,
      kind: message.kind,
      text: message.text,
      ...(message.content ? { content: displayParts(message.content) } : {}),
      title: `${message.agentId ?? (message.actor?.kind === "operator" ? "服务管理员" : message.actor?.kind === "platform" ? actorKey(message.actor) : "MaybeClaw")}${message.taskId ? ` · ${message.taskId.slice(0, 8)}` : ""}`,
      ...(message.taskId ? { runId: message.taskId } : {}),
    }));
    for (const message of this.gateway.messages(session.id, controlActor)) times.set(message.id, message.createdAt);
    const projection = new UiProjection(Infinity);
    for (const item of this.gateway.events(session.id, controlActor)) {
      projection.event(item.event);
      if (item.event.type === "run.event" && "call" in item.event.event) {
        const id = `tool:${item.event.event.runId}:${item.event.event.call.id}`;
        if (!times.has(id)) times.set(id, item.at);
      }
    }
    messages.push(...[...projection.blocks.values()].filter((block) => block.kind === "tool"));
    for (const approval of this.gateway.approvals(controlActor, session.id))
      messages.push({
        id: `approval:${approval.id}`,
        kind: "notice",
        text: approval.text,
        title: `${approval.agentId} · 审批`,
        approval: {
          id: approval.id,
          status: ["expired", "unknown", "resolving"].includes(approval.status)
            ? "cancelled"
            : (approval.status as "pending" | "allowed" | "denied" | "cancelled"),
        },
      });
    for (const approval of this.gateway.approvals(controlActor, session.id))
      times.set(`approval:${approval.id}`, approval.createdAt);
    return messages.sort((a, b) => (times.get(a.id) ?? 0) - (times.get(b.id) ?? 0));
  }
  async media(selectedId: string, id: string) {
    for (const message of this.gateway.messages(selectedId, controlActor))
      for (const part of message.content ?? []) {
        if (part.type === "image" && imageAttachment(part.source).id === id) return readEmbeddedImage(part.source);
      }
    const projection = new UiProjection(Infinity);
    for (const item of this.gateway.events(selectedId, controlActor)) projection.event(item.event);
    const source = projection.mediaSources.get(id);
    if (!source) throw new UiError(404, "图片不属于当前会话。");
    return readEmbeddedImage(source);
  }
  async resources(request: UiPageRequest) {
    return readPage(this.hostId, "resources", this.resourceList(), request, (item, query) =>
      `${item.title} ${item.status}`.toLocaleLowerCase().includes(query),
    );
  }
  async history(selectedId: string, request: UiPageRequest) {
    return historyPage(this.hostId, selectedId, (await this.snapshot(selectedId, true)).blocks, request);
  }
  async field(selectedId: string, request: UiFieldRequest) {
    const block = (await this.snapshot(selectedId, true)).blocks.find((item) => item.id === request.blockId);
    if (!block) throw new UiError(404, "记录不属于当前会话。");
    const text =
      request.field === "request"
        ? "请通过 Agent Session 查询模型请求。"
        : request.field === "diagnostic"
          ? (block.diagnostic?.message ?? "")
          : request.field === "presentation"
            ? (block.presentation?.text ?? "")
            : (block[request.field] ?? "");
    return fieldPage(this.hostId, selectedId, request, text);
  }

  async execute(command: UiCommand): Promise<UiReceipt> {
    return executeGatewayUiCommand(this, command);
  }
}
