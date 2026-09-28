import type { TaskStatus } from "@may/coordination";
import type { AgentApplicationEvent } from "@may/application";
import type { RunResult, Usage } from "@may/core";

/** 各个 MaybeCode 界面看到的委派任务。 */
export interface MaybeCodeDelegationTask {
  readonly id: string;
  readonly parentTaskId?: string;
  /** 执行本任务的已注册角色。 */
  readonly role: string;
  /** 主请求是第 1 层。 */
  readonly depth: number;
  readonly status: TaskStatus;
  readonly sessionId: string;
  /** 子任务最后一个已结束 Run 的真实身份。 */
  readonly runId?: string;
  readonly files?: readonly string[];
  readonly usage?: Usage;
  readonly budget?: { readonly modelCalls: number; readonly totalTokens: number };
  /** 长度有界的结果文本。 */
  readonly output?: string;
  readonly detail?: string;
  /** 本任务通过文件工具修改过的工作区文件。 */
  readonly changedFiles?: readonly string[];
}

export type MaybeCodeDelegationStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "recovery-required"
  | "interrupted";

/** 整次请求的状态：主 Run、全部子任务与请求用量。 */
export interface MaybeCodeDelegationState {
  readonly requestId: string;
  readonly status: MaybeCodeDelegationStatus;
  /** 本请求在主 Session 中执行过的真实 Run 身份。 */
  readonly mainRunIds: readonly string[];
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly tasks: readonly MaybeCodeDelegationTask[];
  readonly budget?: {
    readonly modelCalls: number;
    readonly totalTokens: number;
    readonly maxModelCalls: number;
    readonly maxTotalTokens?: number;
    /** 至少一次调用没有 provider 上报的 usage 时为 false，包括按预留值计账的估计值。 */
    readonly usageComplete: boolean;
  };
}

/** 一次请求中的一个真实 Run，保留自己的身份与结果。 */
export interface MaybeCodeRequestRun {
  readonly runId: string;
  readonly sessionId: string;
  /** 本请求内主 Run 的序号，从 0 开始。 */
  readonly turn: number;
  readonly result: RunResult;
}

/** 子 Agent Session 的工具记录，用于按任务查看。 */
export interface MaybeCodeDelegationToolRecord {
  readonly step: number;
  readonly name: string;
  readonly status: "completed" | "failed" | "recovered" | "interrupted";
  readonly summary: string;
}

export interface MaybeCodeDelegationToolRecords {
  readonly taskId: string;
  readonly sessionId: string;
  readonly records: readonly MaybeCodeDelegationToolRecord[];
  readonly truncated: boolean;
}

export type MaybeCodeDelegationEvent =
  | { readonly type: "delegation.started"; readonly state: MaybeCodeDelegationState }
  | { readonly type: "delegation.updated"; readonly state: MaybeCodeDelegationState }
  | { readonly type: "delegation.finished"; readonly state: MaybeCodeDelegationState }
  | {
      readonly type: "delegation.event";
      readonly taskId: string;
      readonly role: string;
      readonly depth: number;
      readonly sessionId: string;
      readonly event: AgentApplicationEvent;
    };

/** 一次用户请求及其真实 Run 与子任务，跨进程重启保留。 */
export interface MaybeCodeDelegationRequest {
  readonly requestId: string;
  readonly status: MaybeCodeDelegationStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly mainRunIds: readonly string[];
  readonly tasks: readonly MaybeCodeDelegationTask[];
}
