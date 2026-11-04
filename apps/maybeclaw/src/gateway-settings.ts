import { isAbsolute } from "node:path";
import type { MayConfig } from "@sortedyuan/may/config";
import { omitUndefined, resolveRunBudget } from "@sortedyuan/may/core";
import { hostSettings } from "./settings.js";
import { authSettings } from "./gateway-auth.js";
import { readMaybeClawSettings } from "./configuration.js";
import type { GatewayEntry, GatewaySettings } from "./gateway-types.js";

export function gatewaySettings(config: MayConfig): GatewaySettings {
  const settings = readMaybeClawSettings(config);
  hostSettings(config);
  const agents = structuredClone(settings.agents ?? []) as GatewaySettings["agents"];
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new Error(`Agent ID 重复：${agent.id}`);
    ids.add(agent.id);
    if (agent.readDirectory !== undefined && !isAbsolute(agent.readDirectory))
      throw new Error(`Agent ${agent.id}.readDirectory 必须为绝对目录。`);
    if (agent.runBudget !== undefined) resolveRunBudget(agent.runBudget);
  }
  const access = settings.access ?? {};
  const server = settings.server ?? {};
  if (server.auth !== undefined) authSettings(server.auth);
  if (server.publicOrigin !== undefined && new URL(server.publicOrigin).origin !== server.publicOrigin) {
    throw new Error("server.publicOrigin 必须为规范 HTTPS origin，不能包含路径、查询参数、片段或用户信息。");
  }
  const allowedAgents = structuredClone(access.allowedAgents ?? {}) as Record<string, string[]>;
  for (const names of Object.values(allowedAgents))
    for (const id of names) if (!ids.has(id)) throw new Error(`allowedAgents 引用了未登记的 Agent：${id}`);
  return {
    version: 2,
    persistentRules: settings.persistentRules === true,
    agents,
    access: {
      sessionAdmins: structuredClone(access.sessionAdmins ?? {}) as Record<string, string[]>,
      creators: [...(access.creators ?? [])],
      deniedUsers: [...(access.deniedUsers ?? [])],
      allowedAgents,
    },
    idleMs: server.idleMs ?? 600_000,
    shutdownMs: server.shutdownMs ?? 30_000,
    ...omitUndefined({ publicOrigin: server.publicOrigin }),
    approvalMs: server.approvalMs ?? 600_000,
    maxConcurrent: server.maxConcurrent ?? 4,
  };
}
export function gatewayEntry(value: unknown): GatewayEntry {
  const entry = object(value, "聊天入口", ["account", "conversation", "kind", "owner", "threadId"]);
  for (const key of ["account", "conversation", "owner", "threadId"] as const) {
    if (key === "account" || key === "conversation" || entry[key] !== undefined)
      nonempty(entry[key], `聊天入口.${key}`);
  }
  if (entry.kind !== "private" && entry.kind !== "group") throw new Error("聊天入口.kind 必须为 private 或 group。");
  if (entry.kind === "private" && entry.owner === undefined) throw new Error("个人聊天入口需要 owner 身份。");
  if (entry.kind === "group" && entry.owner !== undefined)
    throw new Error("群聊入口通过会话管理员配置管理权限，无需 owner 字段。");
  return structuredClone(entry) as unknown as GatewayEntry;
}
function object(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须为对象。`);
  if (keys)
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} 包含未知字段：${key}`);
  return value as Record<string, unknown>;
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} 必须为 1 至 512 个字符的字符串，不能包含首尾空白或控制字符。`);
  }
}
