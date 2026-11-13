import type {
  CoordinationAgent,
  CoordinationRuntime,
  CoordinationStore,
  CoordinationPolicy,
} from "@sortedyuan/coordination";
import type { PluginHost } from "@sortedyuan/may/plugin";
import { gatewayInput } from "../gateway-input.js";
import { gatewayEntry } from "../gateway-settings.js";
import type { GatewayRepository } from "../gateway-repository.js";
import type { GatewayStore } from "../gateway-store.js";
import type { AgentGateway, GatewayInput, GatewayReceipt } from "../gateway.js";
import {
  actorKey,
  digest,
  entryKey,
  type GatewayActor,
  type GatewayAgentAdapter,
  type GatewayApproval,
  type GatewayBinding,
  type GatewayMessage,
  type GatewaySession,
  type GatewaySettings,
  type GatewayTask,
} from "../gateway-types.js";
import { submitInput } from "./submission.js";

export interface GatewayInputOwner extends Pick<
  AgentGateway,
  | "sessions"
  | "session"
  | "createSession"
  | "manageSession"
  | "changed"
  | "status"
  | "messages"
  | "resolveApproval"
  | "isAdmin"
  | "stop"
> {
  readonly store: GatewayStore;
  readonly repository: GatewayRepository;
  readonly options: { settings: GatewaySettings };
  readonly inputAdmissions: Map<string, Promise<void>>;
  readonly admission: Map<string, { fingerprint: string; job: Promise<GatewayReceipt> }>;
  readonly closing: boolean;
  requireAdmin(session: GatewaySession, actor: GatewayActor): void;
  authorizeAgent(id: string, actor: GatewayActor, entry?: GatewaySession["entry"], acceptedWork?: boolean): void;
  requestApproval(
    session: GatewaySession,
    agentId: string,
    actor: GatewayActor,
    kind: GatewayApproval["kind"],
    requestId: string,
    text: string,
    taskId?: string,
  ): GatewayApproval;
  binding(session: GatewaySession, agentId: string): Promise<GatewayBinding>;
  resolveAdapter(id: string): Promise<GatewayAgentAdapter>;
  record(
    session: GatewaySession,
    data: Omit<GatewayMessage, "id" | "sessionId" | "seq" | "createdAt">,
    deliver?: boolean,
  ): GatewayMessage;
  pluginHost(): Promise<PluginHost>;
  coordinationStore(): CoordinationStore;
  coordinationAgents(session: GatewaySession, actor: GatewayActor, graphId: string): Record<string, CoordinationAgent>;
  policy(session: GatewaySession, actor: GatewayActor): CoordinationPolicy;
  launch(runtime: CoordinationRuntime, id: string): void;
}

const terminal = (status: string) => ["completed", "failed", "cancelled"].includes(status);

export function handle(
  this: GatewayInputOwner,
  text: string,
  actor: GatewayActor,
  input: GatewayInput,
): Promise<GatewayReceipt> {
  if (this.closing) return Promise.reject(new Error("Gateway 正在关闭。"));
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text, "utf8") > 65_536 ||
    typeof input.requestId !== "string" ||
    !input.requestId ||
    input.requestId.length > 256
  )
    return Promise.reject(new Error("消息不得超过 64 KiB，且必须提供有效请求 ID。"));
  if (input.entry) gatewayEntry(input.entry);
  const key = digest({ actor: actorKey(actor), requestId: input.requestId });
  const fingerprint = digest({ text, actor, input });
  const pending = this.admission.get(key);
  if (pending)
    return pending.fingerprint === fingerprint ? pending.job : Promise.reject(new Error("请求 ID 已用于其他输入。"));
  const saved = this.store.get<{ fingerprint: string; result?: GatewayReceipt; error?: string }>("receipts", key);
  if (saved) {
    if (saved.fingerprint !== fingerprint) return Promise.reject(new Error("请求 ID 已用于其他输入。"));
    return saved.result
      ? Promise.resolve(saved.result)
      : Promise.reject(new Error(saved.error ?? "原请求尚无确认结果，请查询会话与任务状态。"));
  }
  this.store.put("receipts", key, { id: key, fingerprint });
  const job = processInput.call(this, text, actor, input).then(
    (result) => {
      this.store.put("receipts", key, { id: key, fingerprint, result, sessionId: result.sessionId ?? null });
      return result;
    },
    (error) => {
      this.store.put("receipts", key, {
        id: key,
        fingerprint,
        error: safeError(error),
        sessionId: input.sessionId ?? null,
      });
      throw error;
    },
  );
  this.admission.set(key, { fingerprint, job });
  void job.finally(() => this.admission.delete(key)).catch(() => undefined);
  return job;
}

export function resolveTargets(
  this: GatewayInputOwner,
  text: string,
  actor: GatewayActor,
  input: GatewayInput,
): { session: GatewaySession; agents: string[] } {
  const parsed = gatewayInput(text),
    words = [...parsed.words];
  let selected = input.sessionId;
  if (words[0] === "/session") {
    words.shift();
    selected = this.session(words.shift() ?? "", actor).id;
  }
  const reply = input.entry && input.replyTo ? this.repository.platformMessage(input.entry, input.replyTo) : undefined;
  selected ??=
    reply?.sessionId ??
    (input.entry ? this.store.get<{ sessionId: string }>("defaults", entryKey(input.entry))?.sessionId : undefined);
  if (!selected) throw new Error("请先创建并选择会话。");
  const session = this.session(selected, actor);
  const explicit = words[0]?.startsWith("@")
    ? words[0].slice(1)
    : reply?.sessionId === session.id
      ? reply.agentId
      : undefined;
  const agents = explicit ? [explicit] : session.defaultAgents;
  for (const id of agents) this.authorizeAgent(id, actor, session.entry);
  return { session, agents };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "Gateway 操作失败。";
}

export async function processInput(
  this: GatewayInputOwner,
  text: string,
  actor: GatewayActor,
  input: GatewayInput,
): Promise<GatewayReceipt> {
  if (actor.kind === "platform" && this.options.settings.access.deniedUsers.includes(actorKey(actor)))
    throw new Error("当前身份已被撤销访问权限。");
  const parsed = gatewayInput(text);
  const words = [...parsed.words];
  if (!words.length) throw new Error("请输入消息。");
  let selected = input.sessionId;
  if (words[0] === "/session") {
    words.shift();
    const target = words.shift();
    if (!parsed.literalSession && target === "list")
      return {
        text:
          this.sessions(actor)
            .map((session) => `${session.id}  ${session.name}  ${session.status}`)
            .join("\n") || "尚无会话。使用 /session create <名称> --agent <Agent> 创建。",
      };
    if (!parsed.literalSession && target === "create") {
      const name = words.shift(),
        agents: string[] = [],
        allowed: string[] = [];
      while (words.length) {
        const flag = words.shift(),
          value = words.shift();
        if (!value || !["--agent", "--allow-agent"].includes(flag!))
          throw new Error("用法：/session create <名称> --agent <Agent> [--allow-agent <Agent>]");
        (flag === "--agent" ? agents : allowed).push(value);
      }
      const session = this.createSession(actor, name ?? "", agents, allowed, input.entry);
      return {
        text: `已创建 ${session.name}\n${session.id}\n使用 /session select ${session.id} 选择会话。`,
        sessionId: session.id,
      };
    }
    if (!parsed.literalSession && target === "select") {
      const session = this.session(words.shift() ?? "", actor);
      this.requireAdmin(session, actor);
      const active = this.store
        .list<GatewayTask>("tasks")
        .filter((task) => task.sessionId === session.id && !terminal(task.status)).length;
      const deliveries = this.repository.deliveries().filter((item) => item.sessionId === session.id);
      const pending = new Set(
        deliveries
          .filter((item) => ["pending", "sending", "failed"].includes(item.status))
          .map((item) => item.messageId),
      ).size;
      const unknown = new Set(deliveries.filter((item) => item.status === "unknown").map((item) => item.messageId))
        .size;
      const progress = `\n进行中的任务：${active}\n未发送消息：${pending}${unknown ? `\n投递结果未确认：${unknown}` : ""}`;
      if (!input.entry) return { text: `已选择 ${session.name}${progress}`, sessionId: session.id };
      this.store.put("defaults", entryKey(input.entry), { sessionId: session.id });
      this.changed();
      return {
        text: `${actorKey(actor)} 已将入口默认会话设置为 ${session.name}。默认 Agent：${session.defaultAgents.join(", ")}${progress}`,
        sessionId: session.id,
      };
    }
    if (!parsed.literalSession && ["archive", "restore", "delete"].includes(target ?? "")) {
      const session = this.session(words.shift() ?? selected ?? "", actor);
      await this.manageSession(session, actor, target!, words.includes("--confirm"));
      return { text: `会话操作已完成：${target}`, sessionId: session.id };
    }
    selected = this.session(target ?? "", actor).id;
  }
  if (words[0] === "/agent" && words[1] === "list")
    return {
      text: this.status()
        .agents.map((agent) => `${agent.id}  ${agent.status}`)
        .join("\n"),
    };
  if (["/status", "/result", "/cancel"].includes(words[0] ?? "") && words[1]) {
    selected ??= this.store.get<GatewayTask>("tasks", words[1])?.sessionId;
  }
  const reply = input.entry && input.replyTo ? this.repository.platformMessage(input.entry, input.replyTo) : undefined;
  selected ??=
    reply?.sessionId ??
    (input.entry ? this.store.get<{ sessionId: string }>("defaults", entryKey(input.entry))?.sessionId : undefined);
  if (!selected)
    throw new Error("请先创建并选择会话：/session create <名称> --agent <Agent>，然后 /session select <会话>。");
  const session = this.session(selected, actor);
  let agentId = words[0]?.startsWith("@")
    ? words.shift()!.slice(1)
    : reply?.sessionId === session.id
      ? reply.agentId
      : undefined;
  const command = words[0];
  if (command === "/history") {
    const marker = words.indexOf("--before"),
      before = marker < 0 ? Infinity : Number(words[marker + 1]);
    if (!(before > 0)) throw new Error("历史游标无效。");
    const messages = this.messages(session.id, actor)
      .filter((message) => message.seq < before)
      .slice(-20);
    return {
      text:
        messages.map((message) => `${message.seq} · ${message.agentId ?? message.kind}\n${message.text}`).join("\n\n") +
        (messages.length ? `\n/history --before ${messages[0]!.seq}` : "暂无历史。"),
      sessionId: session.id,
    };
  }
  if (command === "/approve" || command === "/deny") {
    await this.resolveApproval(
      words[1] ?? "",
      actor,
      command === "/deny"
        ? "deny"
        : words.includes("--persistent")
          ? "allow-persistent"
          : words.includes("--session")
            ? "allow-session"
            : "allow",
    );
    return { text: "审批已处理。", sessionId: session.id };
  }
  if (command === "/status" || command === "/result") {
    const tasks = this.store
      .list<GatewayTask>("tasks")
      .filter((task) => task.sessionId === session.id && (!words[1] || task.id === words[1]));
    return {
      text:
        tasks
          .map(
            (task) =>
              `${task.id} · ${task.agentId} · ${task.status}\n${command === "/result" ? (task.result ?? task.detail ?? "结果尚未生成。") : (task.detail ?? "")}`,
          )
          .join("\n") || "没有对应任务。",
      sessionId: session.id,
    };
  }
  if (command === "/agent") {
    const operation = words[1];
    if (operation === "default" || operation === "allow") {
      if (words.length === 2)
        return {
          text: (operation === "default" ? session.defaultAgents : session.allowedAgents).join(", "),
          sessionId: session.id,
        };
      this.requireAdmin(session, actor);
      const values = [...new Set(words.slice(2))];
      for (const id of values) this.authorizeAgent(id, actor, session.entry);
      const updated = {
        ...session,
        ...(operation === "default"
          ? { defaultAgents: values, allowedAgents: [...new Set([...session.allowedAgents, ...values])] }
          : { allowedAgents: [...new Set([...values, ...session.defaultAgents])] }),
        updatedAt: Date.now(),
      };
      this.store.put("sessions", session.id, updated);
      this.changed();
      return { text: `已修改 ${session.name} 的 ${operation}：${values.join(", ")}`, sessionId: session.id };
    }
    if (operation === "create") {
      if (session.status !== "active") throw new Error("请先恢复会话。");
      const id = words[2] ?? "";
      this.authorizeAgent(id, actor, session.entry);
      if (!session.allowedAgents.includes(id) && !this.isAdmin(session, actor)) {
        const approval = this.requestApproval(session, id, actor, "create-agent", input.requestId, `创建 ${id} 对话`);
        return { text: `等待创建审批：${approval.id}`, sessionId: session.id };
      }
      const binding = await this.binding(session, id);
      return { text: `${id} 对话已就绪：${binding.conversationId}`, sessionId: session.id };
    }
    if (operation === "command") {
      if (session.status !== "active") throw new Error("请先恢复会话。");
      const id = words[2] ?? "",
        name = words[3] ?? "";
      if (["new", "resume", "/new", "/resume"].includes(name))
        throw new Error("请通过 MaybeClaw 会话命令管理 Agent 对话。");
      this.requireAdmin(session, actor);
      this.authorizeAgent(id, actor, session.entry);
      const adapter = await this.resolveAdapter(id),
        binding = await this.binding(session, id);
      if (!adapter.command) throw new Error("该 Agent 没有声明命令能力。");
      return { text: await adapter.command(binding.conversationId!, name, words.slice(4)), sessionId: session.id };
    }
    throw new Error("用法：/agent list|default|allow|create|command");
  }
  if (command === "/stop" || command === "/cancel") {
    const taskId =
      command === "/cancel" ? words[1] : words.includes("--task") ? words[words.indexOf("--task") + 1] : undefined;
    if ((command === "/cancel" && !taskId) || (words.includes("--task") && !taskId))
      throw new Error("请填写任务 ID：/stop --task <ID>。");
    if (words.includes("--session")) {
      const target = this.session(words[words.indexOf("--session") + 1] ?? "", actor);
      this.requireAdmin(target, actor);
      await this.stop(target, actor);
    } else {
      const candidates = this.store
        .list<GatewayTask>("tasks")
        .filter(
          (task) =>
            task.sessionId === session.id &&
            !terminal(task.status) &&
            (!agentId || task.agentId === agentId) &&
            (!taskId || task.id === taskId),
        );
      if (candidates.length > 1)
        throw new Error("存在多个活动任务，请使用 /stop --task <ID>，或 /stop --session <会话>。");
      await this.stop(session, actor, agentId, taskId);
    }
    return { text: "已请求停止，执行状态可通过 /status 查询。", sessionId: session.id };
  }
  if (session.status !== "active") throw new Error("会话已归档或正在删除。请先恢复会话。");
  const steer = command === "/steer";
  if (steer) words.shift();
  else if (command?.startsWith("/") && command !== "--")
    throw new Error("未知 Gateway 命令。使用 /session、/agent、/history、/status、/stop 或 /steer。");
  if (words[0] === "--") words.shift();
  const body = parsed.body ?? words.join(" ");
  if (!body.trim()) throw new Error("消息正文不能为空。");
  return submitInput.call(this, session, actor, input, { agentId, body, steer });
}
