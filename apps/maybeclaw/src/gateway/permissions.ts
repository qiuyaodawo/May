import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import type { FilePermissionRuleStore } from "@sortedyuan/may/permissions/file-store";
import type { PersistentPermissionRule } from "@sortedyuan/may/permissions";
import type { GatewayStore } from "../gateway-store.js";
import { actorKey, type GatewayActor, type GatewaySettings } from "../gateway-types.js";

export interface GatewayPermissionOwner {
  readonly store: GatewayStore;
  readonly options: { directory: string; settings: GatewaySettings };
  ruleStore(): Promise<FilePermissionRuleStore>;
  changed(): void;
}

export async function listPermissionRules(
  this: GatewayPermissionOwner,
  actor: GatewayActor,
): Promise<readonly PersistentPermissionRule[]> {
  if (actor.kind !== "operator") throw new Error("查看持久权限规则需要服务管理员权限。");
  return (await this.ruleStore()).list();
}

export async function revokePermissionRule(
  this: GatewayPermissionOwner,
  id: string,
  actor: GatewayActor,
): Promise<boolean> {
  if (actor.kind !== "operator") throw new Error("撤销持久权限规则需要服务管理员权限。");
  const store = await this.ruleStore();
  const rule = (await store.list()).find((entry) => entry.id === id);
  const revoked = await store.revoke(id);
  if (revoked) {
    const eventId = randomUUID();
    this.store.put("permission-rule-events", eventId, {
      type: "rule.revoked",
      ruleId: id,
      scopeId: rule?.scopeId,
      actor,
      at: Date.now(),
    });
  }
  this.changed();
  return revoked;
}

export async function createPermissionRule(
  this: GatewayPermissionOwner,
  sourceId: string,
  decision: "allow" | "deny",
  actor: GatewayActor,
): Promise<PersistentPermissionRule> {
  if (actor.kind !== "operator") throw new Error("创建持久权限规则需要服务管理员权限。");
  if (decision !== "allow" && decision !== "deny") throw new TypeError("持久权限决定必须为 allow 或 deny。");
  const store = await this.ruleStore();
  const source = (await store.list()).find((rule) => rule.id === sourceId);
  if (!source) throw new Error("来源规则不存在。");
  const scope: unknown = JSON.parse(source.scopeId);
  if (
    !Array.isArray(scope) ||
    scope.length !== 5 ||
    scope[0] !== "maybeclaw-v1" ||
    scope[1] !== resolve(this.options.directory) ||
    typeof scope[2] !== "string" ||
    typeof scope[4] !== "string"
  )
    throw new Error("来源规则不属于当前 Gateway。");
  const agent = this.options.settings.agents.find((item) => item.id === scope[2]);
  if (!agent || agent.adapter !== "may" || agent.enabled === false || agent.permissions?.[source.toolName] === "deny")
    throw new Error("来源规则的 Agent 或工具权限已经失效。");
  if (scope[3] !== (agent.readDirectory ? await realpath(agent.readDirectory) : null))
    throw new Error("来源规则的项目目录已经变化。");
  const identity: unknown = JSON.parse(scope[4]);
  if (
    !Array.isArray(identity) ||
    identity.some((value) => typeof value !== "string" || !value.trim()) ||
    !((identity.length === 2 && identity[0] === "operator") || (identity.length === 3 && identity[0] === "platform"))
  )
    throw new Error("来源规则的身份范围无效。");
  if (identity[0] === "platform" && this.options.settings.access.deniedUsers.includes(`${identity[1]}:${identity[2]}`))
    throw new Error("来源规则的身份权限已经撤销。");
  const createdAt = Date.now();
  if (source.expiresAt !== undefined && source.expiresAt <= createdAt) throw new Error("来源规则已经过期。");
  const rule: PersistentPermissionRule = {
    ...source,
    id: randomUUID(),
    decision,
    createdAt,
    createdBy: actorKey(actor),
  };
  await store.create(rule);
  this.store.put("permission-rule-events", rule.id, { type: "rule.created", rule, actor, at: createdAt });
  this.changed();
  return rule;
}
