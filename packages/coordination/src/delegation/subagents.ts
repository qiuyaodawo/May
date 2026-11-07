import { omitUndefined, resolveRunBudget, type RunBudget } from "@sortedyuan/may/core";
import { MaybeCodeConfigError } from "./errors.js";

/** 子 Agent 角色在共享工作区里可以使用的编码工具。
 * @experimental
 */
export type SubagentToolName = "read" | "shell" | "edit" | "write" | "glob" | "grep" | "fetch";

/** @experimental */
export const SUBAGENT_TOOL_NAMES: readonly SubagentToolName[] = [
  "read",
  "shell",
  "edit",
  "write",
  "glob",
  "grep",
  "fetch",
];

/** @experimental */
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

/** @experimental */
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

/** @experimental */
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

/** 配置文件中经过 JSON Schema 校验的 `subagents` 对象。
 * @experimental
 */
export interface MaybeCodeSubagentSettings {
  readonly enabled?: boolean;
  readonly roles?: Readonly<Record<string, Omit<Partial<MaybeCodeSubagentRole>, "name">>>;
  readonly defaultRole?: string;
  readonly limits?: Partial<MaybeCodeSubagentLimits>;
  readonly runBudget?: RunBudget;
  readonly maxModelCalls?: number;
  readonly maxTotalTokens?: number;
  readonly reservationTokens?: number;
}

const DEFAULT_LIMITS: MaybeCodeSubagentLimits = {
  maxConcurrent: 2,
  maxTasks: 24,
  maxDepth: 3,
  maxTaskTurns: 6,
  maxDurationMs: 900_000,
  maxInputBytes: 32_768,
  maxOutputBytes: 65_536,
};

/** 子 Run 缺省的步数上限；自定义子 Agent 预算省略 maxSteps 时使用。
 * @experimental
 */
export const SUBAGENT_DEFAULT_MAX_STEPS = 24;

const DEFAULT_RUN_BUDGET: RunBudget = {
  maxSteps: SUBAGENT_DEFAULT_MAX_STEPS,
  maxModelCalls: 24,
  maxToolCalls: 48,
  maxDurationMs: 300_000,
};

/** @experimental */
export const DEFAULT_SUBAGENT_ROLE = "worker";

/** worker 角色始终注册，因此不配置也能进行委派。
 * @experimental
 */
export function defaultSubagentConfiguration(): MaybeCodeSubagentConfiguration {
  return Object.freeze({
    roles: Object.freeze([
      Object.freeze({
        name: DEFAULT_SUBAGENT_ROLE,
        tools: Object.freeze([...SUBAGENT_TOOL_NAMES]) as readonly SubagentToolName[],
        delegateTo: Object.freeze([DEFAULT_SUBAGENT_ROLE]) as readonly string[],
      }),
    ]),
    defaultRole: DEFAULT_SUBAGENT_ROLE,
    limits: Object.freeze({ ...DEFAULT_LIMITS }),
    runBudget: DEFAULT_RUN_BUDGET,
    maxModelCalls: 128,
    reservationTokens: 32_768,
  });
}

/** 由已校验的 `apps.maybecode.subagents` 得到委派配置；false 完全关闭委派。
 * @experimental
 */
export function resolveSubagentConfiguration(
  settings: false | MaybeCodeSubagentSettings | undefined,
): false | MaybeCodeSubagentConfiguration {
  if (settings === false || settings?.enabled === false) return false;
  const base = defaultSubagentConfiguration();
  if (settings === undefined) return base;
  const field = "apps.maybecode.subagents";
  const roles =
    settings.roles === undefined
      ? base.roles
      : Object.freeze(
          Object.entries(settings.roles).map(([name, role]) =>
            Object.freeze({
              ...role,
              name,
              tools: Object.freeze([...(role.tools ?? SUBAGENT_TOOL_NAMES)]),
              delegateTo: Object.freeze([...(role.delegateTo ?? [])]),
              ...(role.runBudget === undefined
                ? {}
                : { runBudget: runBudget(role.runBudget, `${field}.roles.${name}.runBudget`) }),
            }),
          ),
        );
  const defaultRole = settings.defaultRole ?? base.defaultRole;
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
  const reservationTokens = settings.reservationTokens ?? base.reservationTokens;
  if (settings.maxTotalTokens !== undefined && settings.maxTotalTokens < reservationTokens) {
    throw new MaybeCodeConfigError(`${field}.maxTotalTokens must hold at least reservationTokens`);
  }
  return Object.freeze(
    omitUndefined({
      roles,
      defaultRole,
      limits: Object.freeze({ ...base.limits, ...settings.limits }),
      runBudget:
        settings.runBudget === undefined ? base.runBudget : runBudget(settings.runBudget, `${field}.runBudget`),
      maxModelCalls: settings.maxModelCalls ?? base.maxModelCalls,
      maxTotalTokens: settings.maxTotalTokens,
      reservationTokens,
    }),
  );
}

function runBudget(value: RunBudget, field: string): RunBudget {
  try {
    return resolveRunBudget(value);
  } catch (error) {
    throw new MaybeCodeConfigError(`${field}: ${(error as Error).message}`, { cause: error });
  }
}
