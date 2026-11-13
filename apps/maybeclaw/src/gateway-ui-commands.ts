import { quote } from "shell-quote";
import {
  commandArgs,
  createTelemetryPanel,
  UiError,
  type UiTelemetryData,
  type UiAction,
  type UiCommand,
  type UiReceipt,
} from "@sortedyuan/ui-client";
import type { ApprovalDecision } from "@sortedyuan/may/permissions";
import type { GatewayUiHost } from "./gateway-ui.js";
import type { GatewayActor, GatewayAgentConfig, GatewayEntry } from "./gateway-types.js";

export const controlActor: GatewayActor = { kind: "operator", id: "control" };

export async function executeGatewayUiCommand(host: GatewayUiHost, command: UiCommand): Promise<UiReceipt> {
  if (command.hostId !== host.hostId) throw new UiError(409, "服务已经重启，请刷新状态。");
  const target = command.targetId ? host.gateway.session(command.targetId, controlActor) : undefined;
  const requestId = `ui:${command.requestId}`;
  if (command.name === "session.activate") {
    commandArgs(command, []);
    if (!command.targetId) throw new UiError(400, "需要选择会话。");
    await host.snapshot(command.targetId);
    return { selectedId: command.targetId };
  }
  if (command.name === "delivery.retry") {
    commandArgs(command, ["id"], ["confirm"]);
    host.gateway.retryDelivery(command.args.id!, controlActor, command.args.confirm === "true");
    return {};
  }
  if (command.name === "gateway.inspect") {
    commandArgs(command, ["kind"]);
    const data =
      command.args.kind === "agents"
        ? host.gateway.configuration(controlActor).agents
        : command.args.kind === "agent-status"
          ? host.gateway.status().agents
          : command.args.kind === "settings"
            ? host.gateway.configuration(controlActor)
            : command.args.kind === "sessions"
              ? host.gateway.sessions(controlActor)
              : command.args.kind === "bindings"
                ? host.gateway.bindings(controlActor)
                : command.args.kind === "tasks"
                  ? {
                      tasks: host.gateway.tasks(controlActor),
                      graphs: host.gateway.coordinationSnapshots(controlActor),
                    }
                  : command.args.kind === "approvals"
                    ? host.gateway.approvals(controlActor)
                    : command.args.kind === "permission-rules"
                      ? await host.gateway.listPermissionRules(controlActor)
                      : command.args.kind === "channels"
                        ? {
                            host: host.hostStatus(),
                            defaults: host.gateway.entryDefaults(controlActor),
                            entries: host.gateway
                              .sessions(controlActor)
                              .filter((item) => item.entry)
                              .map((item) => ({ sessionId: item.id, name: item.name, entry: item.entry })),
                          }
                        : undefined;
    if (data === undefined) throw new UiError(400, "未知管理页面。");
    if (command.args.kind === "permission-rules") {
      const rules = await host.gateway.listPermissionRules(controlActor);
      return {
        output: {
          title: "持久权限规则",
          text: JSON.stringify(rules, null, 2),
          actions: rules.flatMap<UiAction>((rule) => [
            {
              label: `${rule.id} · 保存相同范围的${rule.decision === "allow" ? "禁止" : "允许"}规则`,
              command: "permission.rule.create",
              args: { sourceId: rule.id, decision: rule.decision === "allow" ? "deny" : "allow" },
              confirm: rule.description,
            },
            {
              label: `${rule.id} · 撤销规则`,
              command: "permission.rule.revoke",
              args: { id: rule.id },
              confirm: rule.description,
            },
          ]),
        },
      };
    }
    return { output: { title: "服务管理", text: JSON.stringify(data, null, 2) } };
  }
  if (command.name === "session.new") {
    commandArgs(command, []);
    return {
      output: {
        title: "创建会话",
        text: "使用会话管理器填写名称与默认 Agent，或直接输入创建命令。",
        actions: [
          {
            label: "直接使用命令创建",
            command: "gateway.command",
            args: {},
            input: { name: "text", label: "创建命令", value: "/session create 新会话 --agent " },
          },
        ],
      },
    };
  }
  if (command.name === "session.create") {
    commandArgs(command, ["name", "agents"], ["allowed", "entry"]);
    const entry = command.args.entry ? parseGatewayEntry(JSON.parse(command.args.entry)) : undefined;
    const text = quote([
      "/session",
      "create",
      command.args.name!,
      ...stringList(command.args.agents!).flatMap((id) => ["--agent", id]),
      ...stringList(command.args.allowed ?? "[]").flatMap((id) => ["--allow-agent", id]),
    ]);
    const result = await host.gateway.handle(text, controlActor, { requestId, ...(entry ? { entry } : {}) });
    return { selectedId: result.sessionId ?? null, output: { title: "会话", text: result.text } };
  }
  if (command.name === "gateway.command" || command.name === "message.submit") {
    commandArgs(command, ["text"], ["entry"]);
    if (command.name === "message.submit" && !target) throw new UiError(400, "需要先创建并选择会话。");
    const entry = command.args.entry ? parseGatewayEntry(JSON.parse(command.args.entry)) : undefined;
    const result = await host.gateway.handle(command.args.text!, controlActor, {
      requestId,
      ...(target ? { sessionId: target.id } : {}),
      ...(entry ? { entry } : {}),
    });
    return {
      ...(result.sessionId ? { selectedId: result.sessionId } : {}),
      output: { title: "Gateway", text: result.text },
    };
  }
  if (command.name === "approval.resolve") {
    commandArgs(command, ["id", "decision"]);
    if (!["allow", "allow-session", "allow-persistent", "deny"].includes(command.args.decision!))
      throw new UiError(400, "审批决定无效。");
    await host.gateway.resolveApproval(command.args.id!, controlActor, command.args.decision as ApprovalDecision);
    return {};
  }
  if (command.name === "permission.rule.revoke") {
    commandArgs(command, ["id"]);
    const revoked = await host.gateway.revokePermissionRule(command.args.id!, controlActor);
    return { output: { title: "持久权限规则", text: revoked ? "已撤销规则。" : "规则不存在。" } };
  }
  if (command.name === "permission.rule.create") {
    commandArgs(command, ["sourceId", "decision"]);
    if (command.args.decision !== "allow" && command.args.decision !== "deny")
      throw new UiError(400, "持久权限决定必须为 allow 或 deny。");
    const rule = await host.gateway.createPermissionRule(command.args.sourceId!, command.args.decision, controlActor);
    return { output: { title: "持久权限规则", text: JSON.stringify(rule, null, 2) } };
  }
  if (command.name === "agent.save" || command.name === "agent.delete") {
    commandArgs(command, ["id"], command.name === "agent.save" ? ["config"] : ["confirm"]);
    if (command.name === "agent.delete" && command.args.confirm !== "true")
      throw new UiError(400, "删除 Agent 配置需要明确确认。");
    const config =
      command.name === "agent.save" ? (JSON.parse(command.args.config ?? "null") as GatewayAgentConfig) : null;
    if (command.name === "agent.save" && (!config || typeof config !== "object" || Array.isArray(config)))
      throw new UiError(400, "需要 Agent 配置对象。");
    await host.gateway.updateAgent(command.args.id!, controlActor, config);
    return {};
  }
  if (command.name === "agent.check") {
    commandArgs(command, ["id"], ["refresh"]);
    if (command.args.refresh !== undefined && !["true", "false"].includes(command.args.refresh))
      throw new UiError(400, "refresh 必须为 true 或 false。");
    const adapter = await host.gateway.adapter(command.args.id!);
    const model = await adapter.modelCapabilities?.(command.args.refresh === "true");
    return {
      output: {
        title: "Agent 能力",
        text: JSON.stringify({ agent: adapter.capabilities, ...(model === undefined ? {} : { model }) }, null, 2),
        ...(adapter.modelCapabilities === undefined
          ? {}
          : {
              actions: [
                { label: "刷新模型能力", command: "agent.check", args: { id: command.args.id!, refresh: "true" } },
              ],
            }),
      },
    };
  }
  if (!target) throw new UiError(400, "需要先选择会话。");
  if (command.name === "session.diagnostics") {
    commandArgs(command, []);
    const bindings = host.gateway
      .bindings(controlActor, target.id)
      .filter((binding) => binding.conversationId !== undefined);
    const data = await Promise.all(
      bindings.map(async (binding) => {
        const adapter = await host.gateway.adapter(binding.agentId);
        const result = adapter.diagnostics?.(binding.conversationId!, { limit: 40 }) as UiTelemetryData | undefined;
        return { agentId: binding.agentId, panel: createTelemetryPanel(result) };
      }),
    );
    return {
      output: {
        title: "当前会话执行诊断",
        text:
          data.length === 0
            ? "当前会话尚无 Agent 对话。"
            : data
                .map(
                  ({ agentId, panel }) =>
                    `${agentId}\n${panel.fields.map((field) => `${field.label}: ${field.value}`).join("\n")}`,
                )
                .join("\n\n"),
      },
    };
  }
  if (command.name === "session.rename") {
    commandArgs(command, ["name"]);
    host.gateway.updateSession(target.id, controlActor, { name: command.args.name! });
    return {};
  }
  if (command.name === "session.bind") {
    commandArgs(command, ["entry", "confirm"]);
    host.gateway.updateSession(target.id, controlActor, {
      entry: parseGatewayEntry(JSON.parse(command.args.entry!)),
      confirmBinding: command.args.confirm === "true",
    });
    return {};
  }
  if (command.name === "session.admins") {
    commandArgs(command, ["admins"]);
    await host.gateway.setSessionAdmins(target.id, controlActor, stringList(command.args.admins!));
    return {};
  }
  if (command.name === "run.cancel") {
    commandArgs(command, [], ["task"]);
    await host.gateway.stop(target, controlActor, undefined, command.args.task);
    return {};
  }
  if (["session.archive", "session.restore", "session.delete"].includes(command.name)) {
    commandArgs(command, [], ["confirm"]);
    await host.gateway.manageSession(
      target,
      controlActor,
      command.name.slice(8),
      command.name === "session.delete" && command.args.confirm !== "false",
    );
    return { selectedId: command.name === "session.delete" ? null : target.id };
  }
  if (command.name === "session.default") {
    commandArgs(command, []);
    if (!target.entry) throw new UiError(400, "会话没有绑定聊天入口。");
    const result = await host.gateway.handle(quote(["/session", "select", target.id]), controlActor, {
      requestId,
      entry: target.entry,
    });
    return { output: { title: "聊天入口", text: result.text } };
  }
  if (command.name === "agent.default" || command.name === "agent.allow") {
    commandArgs(command, ["agents"]);
    const result = await host.gateway.handle(
      quote(["/agent", command.name.slice(6), ...stringList(command.args.agents!)]),
      controlActor,
      { requestId, sessionId: target.id },
    );
    return { output: { title: "Agent", text: result.text } };
  }
  throw new UiError(400, "未知管理命令。");
}

export function parseGatewayEntry(value: unknown): GatewayEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UiError(400, "聊天入口必须为对象。");
  const entry = value as GatewayEntry;
  if (
    Object.keys(value).some((key) => !["account", "conversation", "kind", "owner", "threadId"].includes(key)) ||
    !["private", "group"].includes(entry.kind) ||
    typeof entry.account !== "string" ||
    !entry.account.trim() ||
    typeof entry.conversation !== "string" ||
    !entry.conversation.trim() ||
    (entry.kind === "private" && (typeof entry.owner !== "string" || !entry.owner.trim())) ||
    (entry.threadId !== undefined && (typeof entry.threadId !== "string" || !entry.threadId.trim())) ||
    (entry.owner !== undefined && typeof entry.owner !== "string")
  )
    throw new UiError(400, "聊天入口参数不正确。");
  return structuredClone(entry);
}
function stringList(value: string): string[] {
  const result: unknown = JSON.parse(value);
  if (!Array.isArray(result) || result.some((item) => typeof item !== "string" || !item.trim()))
    throw new UiError(400, "需要字符串列表。");
  return result as string[];
}
