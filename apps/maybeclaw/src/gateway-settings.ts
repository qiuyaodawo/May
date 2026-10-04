import { isAbsolute } from "node:path";
import type { MayConfig } from "@may/config";
import { resolveRunBudget, type RunBudget } from "@may/core";
import { parsePluginSelections } from "@may/plugin";
import { hostSettings } from "./settings.js";
import { authSettings } from "./gateway-auth.js";
import type { GatewayAgentConfig, GatewayEntry, GatewaySettings } from "./gateway-types.js";

export function gatewaySettings(config: MayConfig): GatewaySettings {
  const raw = object(config.apps?.maybeclaw ?? {}, "maybeclaw", ["version", "agents", "access", "server", "channels", "runBudget", "persistentRules"]);
  if (raw.version !== 2) throw new Error("MaybeClaw 需要 version: 2 配置。请执行 maybeclaw migrate check 检查已有数据，并配置 agents。");
  if (raw.runBudget !== undefined) throw new Error("请将 maybeclaw.runBudget 配置移至对应的 agents[].runBudget。");
  if (raw.persistentRules !== undefined && typeof raw.persistentRules !== "boolean") throw new TypeError("maybeclaw.persistentRules 必须为布尔值。");
  hostSettings(config);
  if (raw.agents !== undefined && !Array.isArray(raw.agents)) throw new Error("agents 必须为列表。");
  const rawAgents = raw.agents ?? [];
  const ids = new Set<string>();
  const agents = rawAgents.map((value): GatewayAgentConfig => {
    const item = object(value, "Agent", ["id", "name", "adapter", "enabled", "model", "instructions", "readDirectory", "module", "export", "options", "plugins", "idleMs", "runBudget", "permissions", "media"]);
    const id = identifier(item.id, "Agent ID");
    if (ids.has(id)) throw new Error(`Agent ID 重复：${id}`);
    ids.add(id);
    if (item.adapter !== "may" && item.adapter !== "module") throw new Error(`Agent ${id} 的 adapter 必须为 may 或 module。`);
    for (const key of ["model", "instructions", "readDirectory", "module", "export", "name"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") throw new Error(`Agent ${id} 的 ${key} 必须为字符串。`);
      if (item[key] !== undefined && key !== "instructions") nonempty(item[key], `Agent ${id}.${key}`);
    }
    if (item.adapter === "module" && !item.module) throw new Error(`Agent ${id} 需要 module。`);
    if (item.adapter === "may" && ["module", "export", "options"].some(key => item[key] !== undefined)) throw new Error(`Agent ${id} 的 module、export、options 仅用于 module 适配器。`);
    if (item.options !== undefined) object(item.options, `Agent ${id}.options`);
    if (item.plugins !== undefined) {
      if (item.adapter !== "may") throw new Error(`Agent ${id}.plugins 需要 may adapter。`);
      item.plugins = parsePluginSelections(item.plugins);
    }
    if (item.media !== undefined && (!Array.isArray(item.media) || item.media.some(value => !["image", "audio", "file", "video"].includes(value)) || new Set(item.media).size !== item.media.length)) throw new Error(`Agent ${id}.media 需要由 image、audio、file、video 组成的不重复列表。`);
    if (item.readDirectory !== undefined && !isAbsolute(item.readDirectory as string)) throw new Error(`Agent ${id}.readDirectory 必须为绝对目录。`);
    if (item.runBudget !== undefined) resolveRunBudget(item.runBudget as RunBudget);
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") throw new Error(`Agent ${id} 的 enabled 必须为布尔值。`);
    if (item.idleMs !== undefined) positive(item.idleMs, "idleMs", true);
    if (item.permissions !== undefined) for (const [name, rule] of Object.entries(object(item.permissions, "permissions"))) {
      nonempty(name, "permissions 工具名称");
      if (typeof rule !== "string" || !["allow", "deny", "ask"].includes(rule)) throw new Error("permissions 只接受 allow、deny、ask。");
    }
    return structuredClone(item) as unknown as GatewayAgentConfig;
  });
  const access = object(raw.access ?? {}, "access", ["sessionAdmins", "creators", "deniedUsers", "allowedAgents"]);
  const server = object(raw.server ?? {}, "server", ["idleMs", "shutdownMs", "approvalMs", "maxConcurrent", "publicOrigin", "auth"]);
  if (server.auth !== undefined) authSettings(server.auth);
  if (server.publicOrigin !== undefined) {
    nonempty(server.publicOrigin, "server.publicOrigin");
    const origin = new URL(server.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== server.publicOrigin) throw new Error("server.publicOrigin 必须为规范 HTTPS origin，不能包含路径、查询参数、片段或用户信息。");
  }
  const allowedAgents = listMap(access.allowedAgents ?? {}, "allowedAgents");
  for (const names of Object.values(allowedAgents)) for (const id of names) if (!ids.has(id)) throw new Error(`allowedAgents 引用了未登记的 Agent：${id}`);
  const shutdownMs = positive(server.shutdownMs ?? 30_000, "shutdownMs", true);
  if (shutdownMs > 2_147_483_647) throw new Error("shutdownMs 超过 Node 定时器支持范围。");
  return { version: 2, persistentRules: raw.persistentRules === true, agents, access: {
    sessionAdmins: listMap(access.sessionAdmins ?? {}, "sessionAdmins"),
    creators: strings(access.creators ?? [], "creators"),
    deniedUsers: strings(access.deniedUsers ?? [], "deniedUsers"),
    allowedAgents,
  }, idleMs: positive(server.idleMs ?? 600_000, "idleMs", true),
  shutdownMs,
  ...(server.publicOrigin === undefined ? {} : { publicOrigin: server.publicOrigin as string }),
  approvalMs: positive(server.approvalMs ?? 600_000, "approvalMs"),
  maxConcurrent: positive(server.maxConcurrent ?? 4, "maxConcurrent") };
}
export function gatewayEntry(value: unknown): GatewayEntry {
  const entry = object(value, "聊天入口", ["account", "conversation", "kind", "owner", "threadId"]);
  for (const key of ["account", "conversation", "owner", "threadId"] as const) {
    if (key === "account" || key === "conversation" || entry[key] !== undefined) nonempty(entry[key], `聊天入口.${key}`);
  }
  if (entry.kind !== "private" && entry.kind !== "group") throw new Error("聊天入口.kind 必须为 private 或 group。");
  if (entry.kind === "private" && entry.owner === undefined) throw new Error("个人聊天入口需要 owner 身份。");
  if (entry.kind === "group" && entry.owner !== undefined) throw new Error("群聊入口通过会话管理员配置管理权限，无需 owner 字段。");
  return structuredClone(entry) as unknown as GatewayEntry;
}
export function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/.test(value)) throw new Error(`${label} 必须使用 1 至 96 个字母、数字、点、下划线或连字符。`);
  return value;
}
function object(value: unknown, label: string, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} 必须为对象。`);
  if (keys) for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label} 包含未知字段：${key}`);
  return value as Record<string, unknown>;
}
function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须为字符串列表。`);
  for (const item of value) nonempty(item, label);
  return [...new Set(value as string[])];
}
function listMap(value: unknown, label: string): Record<string, string[]> {
  return Object.fromEntries(Object.entries(object(value, label)).map(([key, items]) => {
    nonempty(key, `${label} 标识`);
    return [key, strings(items, label)];
  }));
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} 必须为 1 至 512 个字符的字符串，不能包含首尾空白或控制字符。`);
  }
}
function positive(value: unknown, name: string, zero = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (zero ? 0 : 1)) throw new Error(`${name} 必须为${zero ? "非负" : "正"}整数。`);
  return value as number;
}
