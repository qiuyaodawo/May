import { randomUUID } from "node:crypto";
import type { GatewayStore } from "../gateway-store.js";
import { gatewayEntry } from "../gateway-settings.js";
import {
  actorKey,
  digest,
  entryKey,
  type GatewayActor,
  type GatewayEntry,
  type GatewaySession,
  type GatewaySettings,
} from "../gateway-types.js";

export interface SessionUpdate {
  name?: string;
  defaultAgents?: string[];
  allowedAgents?: string[];
  entry?: GatewayEntry;
  confirmBinding?: boolean;
}

export class GatewayAccess {
  constructor(
    private readonly store: GatewayStore,
    private readonly settings: GatewaySettings,
    private readonly reconfiguring: ReadonlySet<string>,
  ) {}

  requireOperator(actor: GatewayActor): void {
    if (actor.kind !== "operator") throw new Error("此操作需要服务管理员权限。");
  }

  visibleRecords<T extends { sessionId: string }>(collection: string, actor: GatewayActor, sessionId?: string): T[] {
    if (sessionId !== undefined) this.session(sessionId, actor);
    const allowed = new Set(this.sessions(actor).map((session) => session.id));
    return this.store
      .list<T>(collection)
      .filter((record) => allowed.has(record.sessionId) && (sessionId === undefined || record.sessionId === sessionId));
  }

  canAccess(session: GatewaySession, actor: GatewayActor): boolean {
    if (actor.kind === "operator") return true;
    if (this.settings.access.deniedUsers.includes(actorKey(actor))) return false;
    const entry = session.entry;
    return (
      !!entry &&
      entry.account === actor.account &&
      entry.conversation === actor.conversation &&
      (entry.threadId ?? null) === (actor.threadId ?? null) &&
      (entry.kind === "group"
        ? this.store.get<{ active: boolean }>(
            "memberships",
            digest({ account: actor.account, conversation: actor.conversation, userId: actor.userId }),
          )?.active !== false
        : entry.owner === actor.userId)
    );
  }

  isAdmin(session: GatewaySession, actor: GatewayActor): boolean {
    return (
      actor.kind === "operator" ||
      (this.canAccess(session, actor) &&
        (this.settings.access.sessionAdmins[session.id]?.includes(actorKey(actor)) === true ||
          (session.entry?.kind === "private" && session.entry.owner === actor.userId)))
    );
  }

  sessions(actor: GatewayActor): GatewaySession[] {
    return this.store.list<GatewaySession>("sessions").filter((session) => this.canAccess(session, actor));
  }

  session(id: string, actor: GatewayActor): GatewaySession {
    const matches = this.sessions(actor).filter((session) => session.id === id || session.name === id);
    if (matches.length !== 1) throw new Error("会话不存在、名称不唯一或当前身份无权访问。请使用 /session list 查询。");
    return matches[0]!;
  }

  authorizeAgent(id: string, actor: GatewayActor, entry?: GatewayEntry, acceptedWork = false): void {
    const agent = this.settings.agents.find((item) => item.id === id);
    if (!agent || agent.enabled === false || (this.reconfiguring.has(id) && !acceptedWork))
      throw new Error(
        `Agent ${id} 不可用。请使用 /agent list 查看配置，并使用 /agent create <Agent> 尝试创建其他 Agent 对话。`,
      );
    const scope = entry ? entryKey(entry) : actorKey(actor);
    const allowed = this.settings.access.allowedAgents[scope] ?? this.settings.access.allowedAgents[actorKey(actor)];
    if (allowed && !allowed.includes(id)) throw new Error(`当前会话无权使用 Agent ${id}。`);
  }

  requireAdmin(session: GatewaySession, actor: GatewayActor): void {
    if (!this.isAdmin(session, actor)) throw new Error("此操作需要会话管理员权限。");
  }

  createSession(
    actor: GatewayActor,
    name: string,
    agents: string[],
    allowed: string[] = [],
    entry?: GatewayEntry,
  ): GatewaySession {
    if (entry) entry = gatewayEntry(entry);
    if (!name.trim() || name.length > 128 || !agents.length) throw new Error("创建会话需要名称和至少一个默认 Agent。");
    if (
      actor.kind !== "operator" &&
      (entry?.kind !== "private" || entry.owner !== actor.userId) &&
      !this.settings.access.creators.includes(actorKey(actor))
    )
      throw new Error("当前身份没有创建群会话的权限。");
    if (
      actor.kind !== "operator" &&
      (!entry ||
        entry.account !== actor.account ||
        entry.conversation !== actor.conversation ||
        (entry.threadId ?? null) !== (actor.threadId ?? null))
    )
      throw new Error("只能在当前聊天入口创建会话。");
    for (const agent of [...agents, ...allowed]) this.authorizeAgent(agent, actor, entry);
    if (
      this.store
        .list<GatewaySession>("sessions")
        .some(
          (session) =>
            session.name === name && (session.entry ? entry && entryKey(session.entry) === entryKey(entry) : !entry),
        )
    )
      throw new Error("当前入口已有同名会话。");
    const now = Date.now(),
      session: GatewaySession = {
        id: randomUUID(),
        name,
        defaultAgents: [...new Set(agents)],
        allowedAgents: [...new Set([...agents, ...allowed])],
        status: "active",
        createdAt: now,
        updatedAt: now,
        ...(entry ? { entry } : {}),
      };
    this.store.put("sessions", session.id, session);
    return session;
  }

  updateSession(id: string, actor: GatewayActor, update: SessionUpdate): GatewaySession {
    const session = this.session(id, actor);
    this.requireAdmin(session, actor);
    if (update.entry) {
      const checkedEntry = gatewayEntry(update.entry);
      update = { ...update, entry: checkedEntry };
      if (actor.kind !== "operator") throw new Error("绑定聊天入口需要服务管理员权限。");
      if (
        session.entry &&
        (entryKey(session.entry) !== entryKey(checkedEntry) ||
          session.entry.kind !== checkedEntry.kind ||
          session.entry.owner !== checkedEntry.owner)
      )
        throw new Error("已有会话不能更改身份或群聊范围。");
      if (!update.confirmBinding) throw new Error("绑定入口将向目标参与者开放会话历史，请确认 confirmBinding。");
      if (checkedEntry.kind === "private" && !checkedEntry.owner) throw new Error("个人会话需要绑定身份。");
    }
    const name = update.name ?? session.name,
      entry = update.entry ?? session.entry;
    if (!name.trim() || name.length > 128) throw new Error("会话名称无效。");
    if (
      this.store
        .list<GatewaySession>("sessions")
        .some(
          (other) =>
            other.id !== id &&
            other.name === name &&
            (other.entry ? entry && entryKey(other.entry) === entryKey(entry) : !entry),
        )
    )
      throw new Error("目标入口已有同名会话。");
    const defaults = update.defaultAgents ?? session.defaultAgents;
    if (!defaults.length) throw new Error("需要至少一个默认 Agent。");
    const allowed = [...new Set([...(update.allowedAgents ?? session.allowedAgents), ...defaults])];
    for (const agent of [...defaults, ...allowed]) this.authorizeAgent(agent, actor, entry);
    const result: GatewaySession = {
      ...session,
      name,
      defaultAgents: [...new Set(defaults)],
      allowedAgents: allowed,
      ...(entry ? { entry } : {}),
      updatedAt: Date.now(),
    };
    this.store.put("sessions", id, result);
    return result;
  }
}
