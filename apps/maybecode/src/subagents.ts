import { resolveRunBudget, type RunBudget } from "@may/core";
import type { MayConfig } from "@may/config";
import { MaybeCodeConfigError } from "./errors.js";
import { MAYBECODE_APPLICATION_ID } from "./instructions.js";

/** 子 Agent 角色在共享工作区里可以使用的编码工具。 */
export type SubagentToolName = "read" | "shell" | "edit" | "write";

export const SUBAGENT_TOOL_NAMES: readonly SubagentToolName[] = ["read", "shell", "edit", "write"];

export interface MaybeCodeSubagentRole {
  readonly name: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly instructions?: string;
  readonly tools: readonly SubagentToolName[];
  /** 本角色可以通过 delegate_tasks 创建的角色。 */
  readonly delegateTo: readonly string[];
  readonly runBudget?: RunBudget;
}

export interface MaybeCodeSubagentLimits {
  /** 同时运行的子任务数量，主请求所在轮次也占用名额。 */
  readonly maxConcurrent: number;
  /** 每次请求的任务总数，包含主请求。 */
  readonly maxTasks: number;
  /** 主请求是第 1 层；子任务的子任务是第 3 层。 */
  readonly maxDepth: number;
  /** 每个任务的轮次上限，包含主请求所在轮次。 */
  readonly maxTaskTurns: number;
  readonly maxDurationMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

export interface MaybeCodeSubagentConfiguration {
  readonly roles: readonly MaybeCodeSubagentRole[];
  readonly defaultRole: string;
  readonly limits: MaybeCodeSubagentLimits;
  /** 子 Agent 单个 Run 的预算。 */
  readonly runBudget: RunBudget;
  /** 一次请求内主 Run 与全部子 Run 共享的预算。 */
  readonly maxModelCalls: number;
  readonly maxTotalTokens?: number;
  /** provider 不上报 usage 时为一次模型调用预留的 token 数。 */
  readonly reservationTokens: number;
}

const LIMIT_CAPS = {
  maxConcurrent: 8, maxTasks: 128, maxDepth: 4, maxTaskTurns: 16,
  maxDurationMs: 3_600_000, maxInputBytes: 65_536, maxOutputBytes: 262_144,
} as const;

const DEFAULT_LIMITS: MaybeCodeSubagentLimits = {
  maxConcurrent: 2,
  maxTasks: 24,
  maxDepth: 3,
  maxTaskTurns: 6,
  maxDurationMs: 900_000,
  maxInputBytes: 32_768,
  maxOutputBytes: 65_536,
};

/** 子 Run 缺省的步数上限；自定义子 Agent 预算省略 maxSteps 时使用。 */
export const SUBAGENT_DEFAULT_MAX_STEPS = 24;

const DEFAULT_RUN_BUDGET: RunBudget = { maxSteps: SUBAGENT_DEFAULT_MAX_STEPS, maxModelCalls: 24, maxToolCalls: 48, maxDurationMs: 300_000 };

export const DEFAULT_SUBAGENT_ROLE = "worker";

/** worker 角色始终注册，因此不配置也能进行委派。 */
export function defaultSubagentConfiguration(): MaybeCodeSubagentConfiguration {
  return Object.freeze({
    roles: Object.freeze([Object.freeze({
      name: DEFAULT_SUBAGENT_ROLE,
      tools: Object.freeze([...SUBAGENT_TOOL_NAMES]) as readonly SubagentToolName[],
      delegateTo: Object.freeze([DEFAULT_SUBAGENT_ROLE]) as readonly string[],
    })]),
    defaultRole: DEFAULT_SUBAGENT_ROLE,
    limits: Object.freeze({ ...DEFAULT_LIMITS }),
    runBudget: DEFAULT_RUN_BUDGET,
    maxModelCalls: 128,
    reservationTokens: 32_768,
  });
}

/** 解析 apps.maybecode.subagents；false 完全关闭委派。 */
export function resolveSubagentConfiguration(config: MayConfig): false | MaybeCodeSubagentConfiguration {
  const value = config.apps?.[MAYBECODE_APPLICATION_ID]?.subagents;
  if (value === false) return false;
  if (value === undefined) return defaultSubagentConfiguration();
  const field = "apps.maybecode.subagents";
  const record = objectValue(value, field);
  rejectUnknown(record, [
    "enabled", "roles", "defaultRole", "limits", "runBudget",
    "maxModelCalls", "maxTotalTokens", "reservationTokens",
  ], field);
  if (record.enabled === false) return false;
  if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
    throw new MaybeCodeConfigError(`${field}.enabled must be a boolean`);
  }
  const base = defaultSubagentConfiguration();
  const roles = record.roles === undefined
    ? base.roles
    : parseRoles(objectValue(record.roles, `${field}.roles`), field);
  const defaultRole = record.defaultRole === undefined
    ? base.defaultRole
    : identifier(record.defaultRole, `${field}.defaultRole`);
  if (!roles.some((role) => role.name === defaultRole)) {
    throw new MaybeCodeConfigError(`${field}.defaultRole must name a registered role`);
  }
  for (const role of roles) {
    for (const target of role.delegateTo) {
      if (!roles.some((candidate) => candidate.name === target)) {
        throw new MaybeCodeConfigError(`${field}.roles.${role.name}.delegateTo references unknown role "${target}"`);
      }
    }
  }
  const limits = record.limits === undefined
    ? base.limits
    : parseLimits(objectValue(record.limits, `${field}.limits`), field);
  const runBudget = record.runBudget === undefined
    ? base.runBudget
    : parseRunBudget(record.runBudget, `${field}.runBudget`);
  const maxModelCalls = record.maxModelCalls === undefined
    ? base.maxModelCalls
    : positiveInteger(record.maxModelCalls, `${field}.maxModelCalls`, 10_000);
  const maxTotalTokens = record.maxTotalTokens === undefined
    ? undefined
    : positiveInteger(record.maxTotalTokens, `${field}.maxTotalTokens`, Number.MAX_SAFE_INTEGER);
  const reservationTokens = record.reservationTokens === undefined
    ? base.reservationTokens
    : positiveInteger(record.reservationTokens, `${field}.reservationTokens`, 10_000_000);
  if (maxTotalTokens !== undefined && maxTotalTokens < reservationTokens) {
    throw new MaybeCodeConfigError(`${field}.maxTotalTokens must hold at least reservationTokens`);
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    defaultRole,
    limits: Object.freeze(limits),
    runBudget,
    maxModelCalls,
    ...(maxTotalTokens === undefined ? {} : { maxTotalTokens }),
    reservationTokens,
  });
}

function parseRoles(value: Record<string, unknown>, field: string): readonly MaybeCodeSubagentRole[] {
  const names = Object.keys(value);
  if (names.length < 1 || names.length > 8) throw new MaybeCodeConfigError(`${field}.roles must define 1-8 roles`);
  const roles = names.map((name): MaybeCodeSubagentRole => {
    identifier(name, `${field}.roles name`);
    const label = `${field}.roles.${name}`;
    const role = objectValue(value[name], label);
    rejectUnknown(role, ["model", "reasoningEffort", "instructions", "tools", "delegateTo", "runBudget"], label);
    const tools = role.tools === undefined ? [...SUBAGENT_TOOL_NAMES] : stringArray(role.tools, `${label}.tools`, 4);
    for (const tool of tools) {
      if (!SUBAGENT_TOOL_NAMES.includes(tool as SubagentToolName)) {
        throw new MaybeCodeConfigError(`${label}.tools contains unknown tool "${tool}"`);
      }
    }
    const delegateTo = role.delegateTo === undefined ? [] : stringArray(role.delegateTo, `${label}.delegateTo`, 8);
    for (const target of delegateTo) identifier(target, `${label}.delegateTo entry`);
    return Object.freeze({
      name,
      ...(role.model === undefined ? {} : { model: identifier(role.model, `${label}.model`) }),
      ...(role.reasoningEffort === undefined ? {} : { reasoningEffort: text(role.reasoningEffort, `${label}.reasoningEffort`, 64) }),
      ...(role.instructions === undefined ? {} : { instructions: text(role.instructions, `${label}.instructions`, 16_384) }),
      tools: Object.freeze(tools.map((tool) => tool as SubagentToolName)) as readonly SubagentToolName[],
      delegateTo: Object.freeze(delegateTo) as readonly string[],
      ...(role.runBudget === undefined ? {} : { runBudget: parseRunBudget(role.runBudget, `${label}.runBudget`) }),
    });
  });
  const seen = new Set<string>();
  for (const role of roles) {
    if (seen.has(role.name)) throw new MaybeCodeConfigError(`${field}.roles contains duplicate role "${role.name}"`);
    seen.add(role.name);
  }
  return Object.freeze(roles);
}

function parseLimits(value: Record<string, unknown>, field: string): MaybeCodeSubagentLimits {
  rejectUnknown(value, Object.keys(LIMIT_CAPS), `${field}.limits`);
  const result: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const [key, cap] of Object.entries(LIMIT_CAPS)) {
    if (value[key] === undefined) continue;
    result[key] = positiveInteger(value[key], `${field}.limits.${key}`, cap);
  }
  if (result.maxDepth! < 2) throw new MaybeCodeConfigError(`${field}.limits.maxDepth must allow at least one child level`);
  if (result.maxTaskTurns! < 2) throw new MaybeCodeConfigError(`${field}.limits.maxTaskTurns must allow a wakeup turn`);
  return Object.freeze(result as unknown as MaybeCodeSubagentLimits);
}

function parseRunBudget(value: unknown, field: string): RunBudget {
  objectValue(value, field);
  try {
    return resolveRunBudget(value as RunBudget);
  } catch (error) {
    throw new MaybeCodeConfigError(`${field}: ${error instanceof Error ? error.message : "invalid Run budget"}`);
  }
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MaybeCodeConfigError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const names = new Set(allowed);
  const unknown = Object.keys(value).find((name) => !names.has(name));
  if (unknown !== undefined) throw new MaybeCodeConfigError(`${field}.${unknown} is not supported`);
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(value) ||
    ["__proto__", "constructor", "prototype"].includes(value)) {
    throw new MaybeCodeConfigError(`${field} must be a 1-64 character ASCII identifier`);
  }
  return value;
}

function text(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new MaybeCodeConfigError(`${field} must be nonempty text of at most ${maxBytes} bytes`);
  }
  return value;
}

function stringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string") ||
    new Set(value).size !== value.length) {
    throw new MaybeCodeConfigError(`${field} must be an array of at most ${max} unique strings`);
  }
  return value as string[];
}

function positiveInteger(value: unknown, field: string, cap: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > cap) {
    throw new MaybeCodeConfigError(`${field} must be an integer from 1 to ${cap}`);
  }
  return value as number;
}
