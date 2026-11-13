import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { type ApplicationExecution } from "@sortedyuan/may";
import { AsyncEventQueue, omitUndefined } from "@sortedyuan/may/core";
import { type ContextBudget, type ContextCompactionStrategy } from "@sortedyuan/may/context";
import {
  type Model,
  type RunBudget,
  type Tool,
  type TraceAttributes,
  type Tracer,
  type UserMessage,
} from "@sortedyuan/may/core";
import { createCodingTools, type CodingExecutionEnvironment, type FetchToolOptions } from "@sortedyuan/coding-tools";
import {
  CoordinationRuntime,
  createAttachedApplicationAgent,
  createDelegationTool,
  type CoordinationAgent,
  type CoordinationLimits,
  type CoordinationSnapshot,
  type CoordinationTask,
  type TaskExecution,
  type TaskExecutionContext,
  type TaskOutput,
} from "../index.js";
import { taskTurnInputId } from "../index.js";
import { FileCoordinationStore } from "../file-store.js";
import type { ApprovalDecision, PermissionPolicy } from "@sortedyuan/may/permissions";
import type { SessionEvent, SessionStore } from "@sortedyuan/may/session";
import type { SkillRegistry } from "@sortedyuan/may/skills";
import type {
  MaybeCodeDelegationEvent,
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeDelegationTask,
  MaybeCodeDelegationToolRecord,
  MaybeCodeDelegationToolRecords,
} from "./delegation.js";
import type { AutoCompactionMode as MaybeCodeAutoCompactionMode } from "@sortedyuan/may/history-memory";
import type { MaybeCodeRun } from "./delegation.js";
import { delegationInstructions } from "./subagent-instructions.js";
import type { SharedWorkspaceFileGuard } from "./subagent-files.js";
import type { SubagentRequestLedger } from "./subagent-budget.js";
import type { MaybeCodeSubagentConfiguration, MaybeCodeSubagentRole, SubagentToolName } from "./subagents.js";
import { createChildAgent } from "./subagent-child-agent.js";
import {
  MAIN_AGENT,
  MAX_INDEXED_REQUESTS,
  MAX_TOOL_RECORDS,
  OUTPUT_LIMIT,
  VERSION,
  bounded,
} from "./subagent-constants.js";
import { SubagentRequest } from "./subagent-request.js";

export { MAIN_TASK_ID, MAIN_AGENT } from "./subagent-constants.js";

/** @experimental */
export interface SubagentRequestPlan {
  /** 第一轮输入；具体内容与媒体由调用方决定。 */
  readonly input: string | UserMessage;
  /** 本次请求在协调图中的持久文本记录。 */
  readonly record: string;
  /** 宿主提供的第一轮输入身份，例如 steering 输入的 inputId。 */
  readonly inputId?: string;
  readonly runBudget?: RunBudget;
  readonly shouldYield?: () => boolean;
  readonly signal?: AbortSignal;
  readonly traceAttributes?: TraceAttributes;
}

/** @experimental */
export interface SubagentHostOptions {
  readonly execution?: CodingExecutionEnvironment;
  readonly fetch?: FetchToolOptions;
  readonly configuration: MaybeCodeSubagentConfiguration;
  readonly workspace: string;
  /** 每次请求一个持久目录的根目录。 */
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly application: Pick<ApplicationExecution, "submit" | "continue" | "resolveApproval">;
  readonly store: SessionStore;
  readonly model: Model;
  readonly requestRecording: "off" | "required";
  readonly providerBodyRecording: boolean;
  /** 声明了自己 model profile 的角色使用的宿主模型工厂。 */
  readonly createRoleModel?: (role: MaybeCodeSubagentRole) => Model | undefined;
  /** 角色自有模型的上下文预算；没有配置时继承主会话。 */
  readonly contextBudgetFor?: (role: MaybeCodeSubagentRole) => ContextBudget | undefined;
  readonly instructions: string;
  readonly instructionsSource?: () => string;
  readonly projectInstructionsSource?: () => string;
  readonly prepareInstructions?: () => Promise<void>;
  readonly beforeToolExecute?: import("@sortedyuan/may").AgentApplicationOptions["beforeToolExecute"];
  readonly permissionModeSource?: () => string;
  readonly permissionPolicy: PermissionPolicy;
  /** 主任务与子任务共用的文件锁；缺省时按工作区新建一把共享锁。 */
  readonly fileGuard?: SharedWorkspaceFileGuard;
  readonly skills?: SkillRegistry;
  /** 动态宿主目录；子 Agent 以自己的 Session 身份接收其中的工具。 */
  readonly toolSource?: () => Iterable<Tool>;
  readonly contextBudget?: ContextBudget;
  readonly compactionStrategy?: ContextCompactionStrategy;
  /** 主会话的自动压缩模式；子 Agent 依此在自己的模型上重建压缩链。 */
  readonly autoCompactionMode: MaybeCodeAutoCompactionMode;
  readonly maxSteps?: number;
  readonly tracer?: Tracer;
  readonly traceAttributes?: TraceAttributes;
  readonly loadRequests: () => Promise<readonly MaybeCodeDelegationRequest[]>;
  readonly saveRequests: (requests: readonly MaybeCodeDelegationRequest[]) => Promise<void>;
}

/**
 * MaybeCode 普通请求的子 Agent 组合。
 *
 * 每次用户请求都是一张持久协调图：主 Session 执行根任务，模型可以在其中创建
 * 长度有界的子任务，子任务在自己的 Session 中运行。根任务持有主 Session，
 * 子任务不会写入它；同一个 Session 不会被第二个执行方认领。
 * @experimental
 */
export class SubagentHost {
  readonly options: SubagentHostOptions;
  /** 供 TUI、Web UI 与无头调用方使用的结构化委派事件。 */
  readonly events: AsyncIterable<MaybeCodeDelegationEvent>;
  private readonly queue = new AsyncEventQueue<MaybeCodeDelegationEvent>({
    maxBufferedValues: 1024,
    isDroppable: (event) => event.type === "delegation.updated",
  });
  private active: SubagentRequest | undefined;
  /** 最后一个请求的最终状态，请求结束后仍然可以查看。 */
  private lastState: MaybeCodeDelegationState | undefined;
  private context: TaskExecutionContext | undefined;
  private turn: { requestYield(): void } | undefined;
  private readonly approvals = new Map<string, string>();
  /** @internal 持久请求索引，最新的排在前面。 */
  requests: MaybeCodeDelegationRequest[] = [];
  private closed = false;

  constructor(options: SubagentHostOptions) {
    this.options = options;
    this.events = this.queue;
  }

  /** 主 Agent 系统指令中的实时协作部分。 */
  instructions(): string {
    return delegationInstructions(this.options.configuration, this.context !== undefined && this.turn !== undefined);
  }

  /** 当前主 Run 的委派工具；没有活动请求时为空。 */
  tools(): readonly Tool[] {
    const context = this.context;
    const turn = this.turn;
    if (context === undefined || turn === undefined) return [];
    return [
      createDelegationTool(context, () => turn.requestYield(), {
        agents: this.options.configuration.roles.map((role) => role.name),
        maxInputBytes: this.options.configuration.limits.maxInputBytes,
      }),
    ];
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  /** 启动一次用户请求；返回的 Run 以整次请求的结果结束。 */
  async start(plan: SubagentRequestPlan, mode: "submit" | "continue" = "submit"): Promise<MaybeCodeRun> {
    if (this.closed) throw new Error("The sub-agent host is closed");
    if (this.active !== undefined) throw new Error("A sub-agent request is already active");
    const request = new SubagentRequest(this, plan, mode);
    this.active = request;
    try {
      await request.start();
    } catch (error) {
      await this.release(request);
      throw error;
    }
    return request.run;
  }

  /** @internal 当前请求的额度账本；没有活动请求时为 undefined。 */
  ledger(): SubagentRequestLedger | undefined {
    return this.active?.ledger;
  }

  async cancel(reason: string): Promise<boolean> {
    return (await this.active?.cancel(reason)) ?? false;
  }

  /** 读取持久请求索引，并核对被上个进程中断的请求。 */
  async initialize(): Promise<void> {
    this.requests = [...(await this.options.loadRequests())];
    await this.reconcile();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const request = this.active;
    try {
      if (request !== undefined) {
        await request.cancel("MaybeCode is closing");
        await request.waitForSettlement();
      }
    } finally {
      this.approvals.clear();
      this.queue.close();
    }
  }

  /** 批准或拒绝活动请求中子任务的工具请求。 */
  async resolveApproval(requestId: string, decision: ApprovalDecision): Promise<boolean> {
    const taskId = this.approvals.get(requestId);
    const runtime = this.active?.runtime;
    if (taskId === undefined || runtime === undefined) return false;
    return await runtime.resolveApproval(taskId, requestId, decision);
  }

  requestState(): MaybeCodeDelegationState | undefined {
    return this.active?.state ?? this.lastState;
  }

  listRequests(): readonly MaybeCodeDelegationRequest[] {
    return this.requests.map((request) => structuredClone(request));
  }

  /** 工作区此刻持有的子 Session，与它自己的 Session 并列。 */
  ownedSessions(): readonly string[] {
    const tasks = this.active?.state?.tasks ?? [];
    return tasks.filter((task) => task.sessionId !== this.options.sessionId).map((task) => task.sessionId);
  }

  async toolRecords(taskId: string): Promise<MaybeCodeDelegationToolRecords> {
    const tasks = this.active?.state?.tasks ?? this.lastState?.tasks ?? [];
    const task = tasks.find((entry) => entry.id === taskId);
    if (task === undefined || task.sessionId === this.options.sessionId) {
      throw new Error(`Unknown sub-agent task: ${taskId}`);
    }
    return {
      taskId,
      sessionId: task.sessionId,
      ...toolRecords(await this.options.store.read(task.sessionId)),
    };
  }

  /**
   * 只读核对上个进程遗留的运行中请求。
   *
   * 持久的任务状态被报告为中断；停在非终态的任务表示结果未知，
   * 需要人工核对外部影响后记录结论。为了弄清未知结果，不会重放任何工具、
   * 模型调用或子任务 Run。
   */
  async reconcile(): Promise<void> {
    const pending = this.requests.filter((request) => request.status === "running");
    if (pending.length === 0) return;
    const reconciled: MaybeCodeDelegationRequest[] = [];
    for (const request of pending) {
      let snapshot: CoordinationSnapshot | undefined;
      let detail: string | undefined;
      try {
        snapshot = await this.coordinationStore(request.requestId).inspect(request.requestId);
      } catch (error) {
        detail = error instanceof Error ? error.message : String(error);
      }
      const durable = snapshot;
      reconciled.push(
        durable === undefined
          ? {
              ...request,
              status: "interrupted",
              finishedAt: Date.now(),
              tasks: request.tasks.map((task) => ({
                ...task,
                status: "recovery-required",
                detail: detail ?? "没有留下可读的协调记录，任务结果未知",
              })),
            }
          : {
              ...request,
              status: "interrupted",
              finishedAt: Date.now(),
              mainRunIds: [...new Set([...request.mainRunIds, ...runIds(durable)])],
              tasks: durable.tasks.map((task) => interruptedTask(this.projectTask(task, durable, new Map()))),
            },
      );
    }
    this.requests = [...reconciled, ...this.requests.filter((request) => request.status !== "running")].slice(
      0,
      MAX_INDEXED_REQUESTS,
    );
    await this.options.saveRequests(this.requests);
  }

  /**
   * 为一个中断的子任务记录已经核对的结论。
   *
   * 宿主说明核对结果；中断的任务不会被重放。
   */
  async resolveRecovery(
    requestId: string,
    taskId: string,
    finding: string,
    outcome: {
      readonly status: "completed" | "failed" | "cancelled";
      readonly detail: string;
      readonly output?: TaskOutput;
    },
  ): Promise<MaybeCodeDelegationRequest> {
    const record = this.requests.find((request) => request.requestId === requestId);
    if (record === undefined) throw new Error(`Unknown sub-agent request: ${requestId}`);
    if (record.status === "running") {
      throw new Error("Cancel the running request before recording a recovery finding");
    }
    const store = this.coordinationStore(requestId);
    const runtime = await CoordinationRuntime.resume({
      id: requestId,
      store,
      agents: this.agents(),
      policy: this.policy(),
    });
    try {
      await runtime.resolveRecovery(
        `resolve-${requestId}-${taskId}-${randomUUID()}`,
        taskId,
        finding,
        outcome.status === "completed"
          ? { status: "completed", output: outcome.output ?? { text: outcome.detail } }
          : { status: outcome.status, detail: outcome.detail },
      );
    } finally {
      await runtime.close();
    }
    const snapshot = await store.inspect(requestId);
    const tasks =
      snapshot === undefined
        ? record.tasks.map((task) =>
            task.id === taskId ? { ...task, status: outcome.status, detail: outcome.detail } : task,
          )
        : snapshot.tasks.map((task) => interruptedTask(this.projectTask(task, snapshot, new Map())));
    const updated: MaybeCodeDelegationRequest = { ...record, tasks };
    this.requests = this.requests.map((request) => (request.requestId === requestId ? updated : request));
    await this.options.saveRequests(this.requests);
    return structuredClone(updated);
  }

  emit(event: MaybeCodeDelegationEvent): void {
    this.queue.push(event);
  }

  trackApproval(requestId: string, taskId: string): void {
    this.approvals.set(requestId, taskId);
  }

  forgetApproval(requestId: string): void {
    this.approvals.delete(requestId);
  }

  directory(requestId: string): string {
    return join(resolve(this.options.dataDirectory), "subagents", requestId);
  }

  /** @internal 释放已结束的请求，下一次请求才可以开始。 */
  async release(request: SubagentRequest): Promise<void> {
    this.lastState = request.state;
    if (this.active === request) {
      this.active = undefined;
      this.context = undefined;
      this.turn = undefined;
    }
  }

  /** @internal 记录当前 Run 的主任务能力。 */
  bindTurn(context: TaskExecutionContext, turn: { requestYield(): void }): void {
    this.context = context;
    this.turn = turn;
  }

  /** @internal */
  projectTask(
    task: CoordinationTask,
    snapshot: CoordinationSnapshot,
    changedFiles: ReadonlyMap<string, readonly string[]>,
  ): MaybeCodeDelegationTask {
    let depth = 0;
    let current: CoordinationTask | undefined = task;
    while (current !== undefined) {
      depth += 1;
      const parentId: string | undefined = current.parentTaskId;
      current = parentId === undefined ? undefined : snapshot.tasks.find((candidate) => candidate.id === parentId);
    }
    const files = task.files ?? [];
    const changed = changedFiles.get(task.id) ?? [];
    const budget = task.output?.budget;
    return omitUndefined({
      id: task.id,
      parentTaskId: task.parentTaskId,
      role: task.agent === MAIN_AGENT ? "main" : task.agent,
      depth,
      status: task.status,
      sessionId: task.sessionId,
      runId: task.output?.runId,
      files: files.length === 0 ? undefined : files,
      usage: task.output?.usage,
      budget: budget === undefined ? undefined : { modelCalls: budget.modelCalls, totalTokens: budget.totalTokens },
      output: task.output === undefined ? undefined : bounded(task.output.text, OUTPUT_LIMIT),
      detail: task.detail,
      changedFiles: changed.length === 0 ? undefined : changed,
    });
  }

  /** 一次请求图的协调存储；读取、核对与恢复都使用同一路径。 */
  coordinationStore(requestId: string): FileCoordinationStore {
    return new FileCoordinationStore(this.directory(requestId));
  }

  /** @internal 一次请求图的 agent；根任务持有主 Session。 */
  agents(mode: "submit" | "continue" = "submit"): Record<string, CoordinationAgent> {
    const agents: Record<string, CoordinationAgent> = { [MAIN_AGENT]: this.mainAgent(mode) };
    for (const role of this.options.configuration.roles) {
      agents[role.name] = createChildAgent(role, {
        options: this.options,
        activeRequest: () => this.active,
        roleModel: (target) => this.roleModel(target),
        depthOf: (task) => this.depthOf(task),
      });
    }
    return agents;
  }

  /** @inline 宿主对任务创建与委派的授权。 */
  policy() {
    const configuration = this.options.configuration;
    return {
      version: VERSION,
      authorize: (task: { agent: string }) =>
        task.agent === MAIN_AGENT || configuration.roles.some((role) => role.name === task.agent),
      authorizeDelegation: (parent: { agent: string }, child: { agent: string }) =>
        parent.agent === MAIN_AGENT
          ? configuration.roles.some((role) => role.name === child.agent)
          : configuration.roles.find((role) => role.name === parent.agent)?.delegateTo.includes(child.agent) === true,
    };
  }

  /** @inline 一次请求图的执行限制。 */
  limits(): Partial<CoordinationLimits> {
    const limits = this.options.configuration.limits;
    return {
      maxConcurrent: limits.maxConcurrent,
      maxTasks: limits.maxTasks,
      maxDepth: limits.maxDepth,
      maxTaskTurns: limits.maxTaskTurns,
      maxDurationMs: limits.maxDurationMs,
      maxInputBytes: limits.maxInputBytes,
      maxOutputBytes: limits.maxOutputBytes,
    };
  }

  /** @inline 子 Agent 的模型：角色未声明 profile 时复用主会话模型与 effort。 */
  roleModel(role: MaybeCodeSubagentRole): Model {
    return role.model === undefined ? this.options.model : (this.options.createRoleModel?.(role) ?? this.options.model);
  }

  private mainAgent(mode: "submit" | "continue"): CoordinationAgent {
    const options = this.options;
    return createAttachedApplicationAgent({
      version: VERSION,
      mode,
      read: (sessionId) => options.store.read(sessionId),
      // steering 输入已经带有 Session 自己的 inputId，沿用它作为本轮的持久身份。
      identity: (execution, turn) =>
        (turn.first ? this.active?.inputIdentity() : undefined) ?? taskTurnInputId(execution),
      attach: (execution) => {
        const turn = execution.task.turn ?? 0;
        return {
          submit: async (submitOptions) => {
            const run = await options.application.submit(submitOptions);
            this.active?.beginMainRun(run.id, turn, run.result);
            return run;
          },
          continue: async (continueOptions) => {
            const run = await options.application.continue(continueOptions);
            this.active?.beginMainRun(run.id, turn, run.result);
            return run;
          },
          resolveApproval: (requestId, decision) => options.application.resolveApproval(requestId, decision),
        };
      },
      submit: (execution, turn, context) => {
        const request = this.active;
        if (request === undefined) throw new Error("The sub-agent request is no longer active");
        this.bindTurn(context, turn);
        return request.submitOptions(turn);
      },
    });
  }

  private depthOf(task: CoordinationTask): number {
    const snapshot = this.active?.runtime?.snapshot();
    if (snapshot === undefined) return 1;
    let depth = 0;
    let current: CoordinationTask | undefined = task;
    while (current !== undefined) {
      depth += 1;
      const parentId: string | undefined = current.parentTaskId;
      current = parentId === undefined ? undefined : snapshot.tasks.find((candidate) => candidate.id === parentId);
    }
    return depth;
  }
}

function runIds(snapshot: CoordinationSnapshot): readonly string[] {
  return snapshot.tasks.flatMap((task) => (task.output?.runId === undefined ? [] : [task.output.runId]));
}

/**
 * 进程结束后停在非终态的任务，结果未知，投影为 recovery-required。
 *
 * 协调记录本身不被改写；核对外部影响之后用 /delegations resolve 记录结论。
 */
function interruptedTask(task: MaybeCodeDelegationTask): MaybeCodeDelegationTask {
  if (["completed", "failed", "cancelled", "recovery-required"].includes(task.status)) return task;
  return {
    ...task,
    status: "recovery-required",
    detail: `进程已结束，持久记录停在 ${task.status}，结果未知：核对外部影响后使用 /delegations resolve 记录结论`,
  };
}

function toolRecords(events: readonly SessionEvent[]): {
  records: readonly MaybeCodeDelegationToolRecord[];
  truncated: boolean;
} {
  const records: MaybeCodeDelegationToolRecord[] = [];
  let truncated = false;
  for (const event of events) {
    if (event.type !== "tool.completed" && event.type !== "tool.failed") continue;
    if (records.length >= MAX_TOOL_RECORDS) {
      truncated = true;
      break;
    }
    records.push({
      step: event.step,
      name: event.call.name,
      status: event.type === "tool.completed" ? "completed" : "failed",
      summary: bounded(event.type === "tool.completed" ? describe(event.output) : event.error.message, 300),
    });
  }
  return { records, truncated };
}

function describe(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}
