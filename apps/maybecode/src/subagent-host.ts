import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { defineAgent, type AgentApplication, type AgentApplicationEvent } from "@may/application";
import { AsyncEventQueue } from "@may/core";
import {
  InMemoryContextFactory,
  ModelContextCompactionStrategy,
  PruneOldToolResultsStrategy,
  SummaryTailStrategy,
  type ContextBudget,
  type ContextCompactionStrategy,
} from "@may/context";
import {
  RunCancelledError,
  resolveRunBudget,
  type Model,
  type RunBudget,
  type RunResult,
  type Tool,
  type TraceAttributes,
  type Tracer,
  type UserMessage,
} from "@may/core";
import { createCodingTools } from "@may/coding-tools";
import {
  CoordinationRuntime,
  createApplicationAgent,
  createAttachedApplicationAgent,
  createDelegationTool,
  type CoordinationAgent,
  type CoordinationLimits,
  type CoordinationSnapshot,
  type CoordinationTask,
  type TaskExecution,
  type TaskExecutionContext,
  type TaskOutput,
} from "@may/coordination";
import { taskTurnInputId } from "@may/coordination";
import { FileCoordinationStore } from "@may/coordination/file-store";
import type { ApprovalDecision, PermissionPolicy } from "@may/permissions";
import type { SessionEvent, SessionStore, SessionSubmitOptions } from "@may/session";
import type { SkillRegistry } from "@may/skills";
import type {
  MaybeCodeDelegationEvent,
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeDelegationTask,
  MaybeCodeDelegationToolRecord,
  MaybeCodeDelegationToolRecords,
  MaybeCodeRequestRun,
} from "./delegation.js";
import type { MaybeCodeAutoCompactionMode } from "./controller.js";
import type { MaybeCodeRun } from "./events.js";
import { delegationInstructions, subagentInstructions } from "./subagent-instructions.js";
import { SharedWorkspaceFileGuard, type SubagentFileGuard } from "./subagent-files.js";
import { SubagentRequestLedger, withRequestBudget } from "./subagent-budget.js";
import { HistoryReferenceMemory } from "./history-memory.js";
import { createModelContextSummarizer } from "./summarizer.js";
import type { SharedBudgetTotals as SubagentBudgetTotals } from "@may/coordination";
import type {
  MaybeCodeSubagentConfiguration,
  MaybeCodeSubagentRole,
  SubagentToolName,
} from "./subagents.js";
import { SUBAGENT_DEFAULT_MAX_STEPS } from "./subagents.js";

/** 主会话与子 Agent 共用的自动压缩链构造。 */
function automaticCompactionStrategies(
  mode: MaybeCodeAutoCompactionMode,
  summary: ContextCompactionStrategy,
  historyReference: ContextCompactionStrategy,
  native: ContextCompactionStrategy | undefined,
): readonly ContextCompactionStrategy[] {
  switch (mode) {
    case "prune-summary": return [new PruneOldToolResultsStrategy(), summary];
    case "history-reference": return [historyReference];
    case "provider-native":
      if (native === undefined) throw new Error("This model does not support provider-native context compaction");
      return [native];
    default: throw new Error(`Unknown automatic compaction mode: ${String(mode)}`);
  }
}

/** 主请求在协调图中的任务 id 与 agent 名称。 */
export const MAIN_TASK_ID = "request";
export const MAIN_AGENT = "main";
const VERSION = "maybecode-subagent-v1";
const OUTPUT_LIMIT = 4_000;
const MAX_TOOL_RECORDS = 64;
const MAX_INDEXED_REQUESTS = 16;

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

export interface SubagentHostOptions {
  readonly configuration: MaybeCodeSubagentConfiguration;
  readonly workspace: string;
  /** 每次请求一个持久目录的根目录。 */
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly application: AgentApplication;
  readonly store: SessionStore;
  readonly model: Model;
  /** 声明了自己 model profile 的角色使用的宿主模型工厂。 */
  readonly createRoleModel?: (role: MaybeCodeSubagentRole) => Model | undefined;
  /** 角色自有模型的上下文预算；没有配置时继承主会话。 */
  readonly contextBudgetFor?: (role: MaybeCodeSubagentRole) => ContextBudget | undefined;
  readonly instructions: string;
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
    return delegationInstructions(this.options.configuration, this.active !== undefined);
  }

  /** 当前主 Run 的委派工具；没有活动请求时为空。 */
  tools(): readonly Tool[] {
    const context = this.context;
    const turn = this.turn;
    if (context === undefined || turn === undefined) return [];
    return [createDelegationTool(context, () => turn.requestYield(), {
      agents: this.options.configuration.roles.map((role) => role.name),
      maxInputBytes: this.options.configuration.limits.maxInputBytes,
      guidance: "Children work in the current workspace. Declare the files each child owns so writes outside them are refused.",
    })];
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
    this.requests = [...await this.options.loadRequests()];
    await this.reconcile();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const request = this.active;
    try {
      if (request !== undefined) {
        await request.cancel("MaybeCode is closing");
        await request.settled;
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
    return tasks
      .filter((task) => task.sessionId !== this.options.sessionId)
      .map((task) => task.sessionId);
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
      reconciled.push(durable === undefined
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
          });
    }
    this.requests = [...reconciled, ...this.requests.filter((request) => request.status !== "running")]
      .slice(0, MAX_INDEXED_REQUESTS);
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
    const tasks = snapshot === undefined
      ? record.tasks.map((task) => task.id === taskId ? { ...task, status: outcome.status, detail: outcome.detail } : task)
      : snapshot.tasks.map((task) => interruptedTask(this.projectTask(task, snapshot, new Map())));
    const updated: MaybeCodeDelegationRequest = { ...record, tasks };
    this.requests = this.requests.map((request) => request.requestId === requestId ? updated : request);
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
    return {
      id: task.id,
      ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
      role: task.agent === MAIN_AGENT ? "main" : task.agent,
      depth,
      status: task.status,
      sessionId: task.sessionId,
      ...(task.output?.runId === undefined ? {} : { runId: task.output.runId }),
      ...(files.length === 0 ? {} : { files }),
      ...(task.output?.usage === undefined ? {} : { usage: task.output.usage }),
      ...(task.output?.budget === undefined
        ? {}
        : { budget: { modelCalls: task.output.budget.modelCalls, totalTokens: task.output.budget.totalTokens } }),
      ...(task.output === undefined ? {} : { output: bounded(task.output.text, OUTPUT_LIMIT) }),
      ...(task.detail === undefined ? {} : { detail: task.detail }),
      ...(changed.length === 0 ? {} : { changedFiles: changed }),
    };
  }

  /** 一次请求图的协调存储；读取、核对与恢复都使用同一路径。 */
  coordinationStore(requestId: string): FileCoordinationStore {
    return new FileCoordinationStore(this.directory(requestId));
  }

  /** @internal 一次请求图的 agent；根任务持有主 Session。 */
  agents(mode: "submit" | "continue" = "submit"): Record<string, CoordinationAgent> {
    const agents: Record<string, CoordinationAgent> = { [MAIN_AGENT]: this.mainAgent(mode) };
    for (const role of this.options.configuration.roles) agents[role.name] = this.childAgent(role);
    return agents;
  }

  /** @inline 宿主对任务创建与委派的授权。 */
  policy() {
    const configuration = this.options.configuration;
    return {
      version: VERSION,
      authorize: (task: { agent: string }) => task.agent === MAIN_AGENT ||
        configuration.roles.some((role) => role.name === task.agent),
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
    return role.model === undefined ? this.options.model : this.options.createRoleModel?.(role) ?? this.options.model;
  }

  private mainAgent(mode: "submit" | "continue"): CoordinationAgent {
    const options = this.options;
    return createAttachedApplicationAgent({
      version: VERSION,
      mode,
      read: (sessionId) => options.store.read(sessionId),
      // steering 输入已经带有 Session 自己的 inputId，沿用它作为本轮的持久身份。
      identity: (execution, turn) => (turn.first ? this.active?.inputIdentity() : undefined) ?? taskTurnInputId(execution),
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

  private childAgent(role: MaybeCodeSubagentRole): CoordinationAgent {
    const options = this.options;
    const host = this;
    const memories = new Map<string, HistoryReferenceMemory>();
    const scoped = createApplicationAgent({
      version: VERSION,
      store: options.store,
      delegation: role.delegateTo.length > 0,
      onOpen: (application, execution) => memories.get(execution.task.sessionId)!.attach(application),
      definition: ({ tools, execution }) => {
        const request = host.active;
        if (request === undefined) throw new Error("The sub-agent request is no longer active");
        const coding = role.tools;
        const files = (options.fileGuard ?? new SharedWorkspaceFileGuard(options.workspace)).create({
          names: coding,
          requireRead: true,
          ...(execution.task.files === undefined ? {} : { files: execution.task.files }),
        });
        const contextBudget = role.model === undefined
          ? options.contextBudget
          : options.contextBudgetFor?.(role) ?? options.contextBudget;
        const roleBudget = resolveRunBudget(role.runBudget, options.configuration.runBudget);
        // 角色预算与子 Agent 预算取较小的值；两者都省略 maxSteps 时用子 Agent 默认值。
        const maxSteps = roleBudget.maxSteps ?? options.maxSteps ?? SUBAGENT_DEFAULT_MAX_STEPS;
        const childModel = withRequestBudget(host.roleModel(role), () => request.ledger);
        const memory = new HistoryReferenceMemory(options.autoCompactionMode === "history-reference");
        memories.set(execution.task.sessionId, memory);
        const summary = new SummaryTailStrategy({ summarizer: createModelContextSummarizer(childModel) });
        request.registerGuard(execution.task.id, files);
        return defineAgent({
          model: childModel,
          tools: [...files.tools, ...tools, ...memory.tools()],
          toolScope: { workspaceId: options.workspace },
          toolSource: () => [...(options.toolSource?.() ?? [])],
          instructions: subagentInstructions({
            base: options.instructions,
            role,
            workspace: options.workspace,
            maxDepthReached: this.depthOf(execution.task) >= options.configuration.limits.maxDepth,
          }),
          ...(options.skills === undefined ? {} : { skills: options.skills }),
          permissionPolicy: options.permissionPolicy,
          sessionHistory: { retrieval: true },
          contextFactory: memory.wrap(new InMemoryContextFactory()),
          ...(contextBudget === undefined ? {} : { contextBudget }),
          ...(options.compactionStrategy === undefined ? {} : { compactionStrategy: options.compactionStrategy }),
          autoCompactionStrategies: automaticCompactionStrategies(
            options.autoCompactionMode,
            summary,
            memory.strategy,
            childModel.contextCompactor === undefined
              ? undefined
              : new ModelContextCompactionStrategy(childModel.contextCompactor),
          ),
          // maxSteps 已确定，角色预算与子 Agent 预算的较小值对子 Run 同样生效。
          maxSteps,
          runBudget: roleBudget,
          ...(options.tracer === undefined ? {} : { tracer: options.tracer }),
          traceAttributes: {
            ...(options.traceAttributes ?? {}),
            "may.agent.name": "maybecode-subagent",
            "may.task.role": role.name,
          },
          closeReason: "Sub-agent Session is closing",
        });
      },
    });
    return {
      version: VERSION,
      async execute(execution, context) {
        try {
          const output = await scoped.execute(execution, context);
          if ("yielded" in output) return output;
          const note = host.active?.guard(execution.task.id)?.note() ?? "";
          return note === "" ? output : { ...output, text: `${output.text}${note}` };
        } finally {
          memories.delete(execution.task.sessionId);
        }
      },
      recover: (execution) => scoped.recover(execution),
      resolveApproval: async (sessionId, requestId, decision) =>
        await scoped.resolveApproval?.(sessionId, requestId, decision) ?? false,
    };
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

interface MainRunRecord {
  readonly runId: string;
  readonly turn: number;
  readonly result: Promise<RunResult>;
  settled?: { readonly ok: true; readonly value: RunResult } | { readonly ok: false; readonly error: unknown };
}

/** 一次用户请求：主 Session、它的子任务与请求额度账本。 */
class SubagentRequest {
  readonly requestId = `req-${randomUUID()}`;
  readonly run: MaybeCodeRun;
  state: MaybeCodeDelegationState | undefined;
  settled: Promise<void> = Promise.resolve();
  runtime: CoordinationRuntime | undefined;
  ledger: SubagentRequestLedger | undefined;
  private totals: SubagentBudgetTotals = {
    modelCalls: 0, totalTokens: 0, costUsd: 0, blocked: false, usageComplete: true,
  };
  private budgetReason: string | undefined;
  /** 账本中每一次调用都按 provider 上报的 usage 结账时为 true。 */
  private usageComplete = true;
  private readonly guards = new Map<string, SubagentFileGuard>();
  private readonly records: MainRunRecord[] = [];
  private readonly startedAt = Date.now();
  private firstRunId: string | undefined;
  private resolveFirstRun!: (id: string) => void;
  private rejectFirstRun!: (error: unknown) => void;
  private readonly firstRun: Promise<string>;
  private resolveResult!: (result: RunResult) => void;
  private rejectResult!: (error: unknown) => void;
  private readonly result: Promise<RunResult>;
  private relay: Promise<void> | undefined;
  private cancelCommands = 0;
  private cancelling: string | undefined;
  private failure: Error | undefined;
  private ended = false;
  private cancellingPromise: Promise<boolean> | undefined;

  constructor(readonly host: SubagentHost, private readonly plan: SubagentRequestPlan, private readonly mode: "submit" | "continue") {
    this.firstRun = new Promise<string>((resolve, reject) => {
      this.resolveFirstRun = resolve;
      this.rejectFirstRun = reject;
    });
    this.result = new Promise<RunResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    // 调用方会观察结果；请求本身不会留下无人处理的结果。
    void this.firstRun.catch(() => undefined);
    void this.result.catch(() => undefined);
    const self = this;
    this.run = {
      get id(): string { return self.firstRunId ?? self.requestId; },
      requestId: this.requestId,
      result: this.result,
      cancel: (reason?: string) => { void this.cancel(reason ?? "Cancelled by user"); },
      runs: () => this.mainRuns(),
    };
  }

  changedFiles(): Map<string, readonly string[]> {
    return new Map([...this.guards].map(([id, guard]) => [id, guard.changedFiles()]));
  }

  registerGuard(taskId: string, guard: SubagentFileGuard): void {
    this.guards.set(taskId, guard);
  }

  guard(taskId: string): SubagentFileGuard | undefined {
    return this.guards.get(taskId);
  }

  /** 一轮主会话的 submit 选项；身份与取消由 agent 负责。 */
  submitOptions(turn: { readonly first: boolean }): SessionSubmitOptions {
    if (this.budgetReason !== undefined) void this.cancel(this.budgetReason);
    return {
      input: this.plan.input,
      ...(this.plan.runBudget === undefined ? {} : { runBudget: this.plan.runBudget }),
      ...(this.plan.shouldYield === undefined ? {} : { shouldYield: this.plan.shouldYield }),
      ...(this.plan.signal === undefined ? {} : { signal: this.plan.signal }),
      traceAttributes: {
        ...(this.plan.traceAttributes ?? {}),
        "may.request.id": this.requestId,
      },
    };
  }

  observeMainRun(runId: string, turn: number, result: Promise<RunResult>): void {
    const record: MainRunRecord = { runId, turn, result };
    this.records.push(record);
    if (this.firstRunId === undefined) {
      this.firstRunId = runId;
      this.resolveFirstRun(runId);
    }
    void result.then(async (value) => {
      record.settled = { ok: true, value };
      await this.checkBudget();
      this.refresh();
    }, (error: unknown) => {
      record.settled = { ok: false, error };
      if (this.failure === undefined && !(error instanceof RunCancelledError)) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
      this.refresh();
    }).catch(() => undefined);
  }

  /** @internal 真实主 Run 的身份，在 Run 启动时捕获。 */
  /** 宿主为第一轮提供的输入身份；普通请求没有额外身份。 */
  inputIdentity(): string | undefined {
    return this.plan.inputId;
  }

  beginMainRun(runId: string, turn: number, result: Promise<RunResult>): void {
    this.observeMainRun(runId, turn, result);
  }

  /** 本请求的真实 Run，每个都保留自己的身份与结果。 */
  async mainRuns(): Promise<readonly MaybeCodeRequestRun[]> {
    await Promise.allSettled(this.records.map((record) => record.result));
    return this.records.flatMap((record) => record.settled === undefined
      ? []
      : record.settled.ok
        ? [{ runId: record.runId, sessionId: this.host.options.sessionId, turn: record.turn, result: record.settled.value }]
        : []);
  }

  /** 停止请求：主 Run、全部子任务及其后代。 */
  async cancel(reason: string): Promise<boolean> {
    this.cancelling ??= reason;
    const runtime = this.runtime;
    if (runtime === undefined) {
      const error = new RunCancelledError(reason);
      this.rejectFirstRun(error);
      this.rejectResult(error);
      return true;
    }
    this.cancellingPromise ??= runtime.cancel(`cancel-${this.requestId}-${this.cancelCommands++}`)
      .then(() => true, (error: unknown) => {
        this.failure ??= error instanceof Error ? error : new Error(String(error));
        return false;
      });
    return this.cancellingPromise;
  }

  /** 账本阻塞时给出准确原因，并在下一次主会话调用前停止请求。 */
  private async checkBudget(): Promise<void> {
    const ledger = this.ledger;
    if (ledger === undefined) return;
    const totals = await ledger.totals();
    this.totals = totals;
    // usage 完整性直接来自账本：没有上报 usage 的调用与按预留值计账的估计值都使它为 false。
    this.usageComplete = totals.usageComplete;
    if (!totals.blocked || this.cancelling !== undefined) return;
    const configuration = this.host.options.configuration;
    this.budgetReason ??= totals.modelCalls > configuration.maxModelCalls
      ? `Request model call budget exhausted: ${totals.modelCalls}/${configuration.maxModelCalls}`
      : configuration.maxTotalTokens !== undefined && totals.totalTokens > configuration.maxTotalTokens
        ? `Request token budget exhausted: ${totals.totalTokens}/${configuration.maxTotalTokens} tokens`
        : "Request model usage is unknown; the request stops before the next model call";
    this.failure ??= new Error(this.budgetReason);
  }

  async start(): Promise<void> {
    const host = this.host;
    const options = host.options;
    const configuration = options.configuration;
    this.ledger = await SubagentRequestLedger.open(host.directory(this.requestId), this.requestId, {
      maxModelCalls: configuration.maxModelCalls,
      ...(configuration.maxTotalTokens === undefined ? {} : { maxTotalTokens: configuration.maxTotalTokens }),
      reservationTokens: configuration.reservationTokens,
    });
    this.totals = await this.ledger.totals();
    await this.checkBudget();
    let runtime: CoordinationRuntime;
    try {
      runtime = await CoordinationRuntime.create({
        id: this.requestId,
        store: this.host.coordinationStore(this.requestId),
        agents: host.agents(this.mode),
        policy: host.policy(),
        limits: host.limits(),
        tasks: [{
          id: MAIN_TASK_ID,
          agent: MAIN_AGENT,
          input: bounded(this.plan.record, configuration.limits.maxInputBytes),
        }],
        sessionIds: { [MAIN_TASK_ID]: options.sessionId },
      });
    } catch (error) {
      // 协调图创建失败时释放账本，避免请求目录残留未关闭的写入者。
      await this.ledger.close();
      throw error;
    }
    this.runtime = runtime;
    this.state = this.project(runtime.snapshot());
    host.emit({ type: "delegation.started", state: this.state });
    await this.save();
    this.relay = this.relayEvents(runtime);
    this.settled = this.settle(runtime);
    void this.settled.catch(() => undefined);
    void runtime.start().catch((error: unknown) => { this.failure ??= asError(error); });
    await this.firstRun;
  }

  private async settle(runtime: CoordinationRuntime): Promise<void> {
    let outcome: RunResult | Error;
    try {
      const snapshot = await runtime.wait();
      // 结束时重新读取账本，报告真实的调用次数、usage 完整性与阻塞状态。
      await this.checkBudget();
      this.state = this.project(snapshot);
      const main = snapshot.tasks.find((task) => task.id === MAIN_TASK_ID);
      outcome = main?.status === "completed" ? this.resultOf(main) : failure(main, this.failure, this.cancelling);
    } catch (error) {
      outcome = asError(error);
    }
    if (this.state !== undefined) this.host.emit({ type: "delegation.finished", state: structuredClone(this.state) });
    try {
      await this.closeRuntime(runtime);
    } catch (error) {
      // 资源释放失败必须让调用者看到，不能以成功结果掩盖。
      this.failure ??= asError(error);
      outcome = this.failure;
    }
    // 先释放宿主再结束请求结果，保证新的用户输入不会遇到活动请求。
    await this.save();
    await this.host.release(this);
    if (outcome instanceof Error) {
      if (this.records.length === 0) this.rejectFirstRun(outcome);
      this.rejectResult(outcome);
    } else {
      this.resolveResult(outcome);
    }
  }

  private resultOf(main: CoordinationTask): RunResult | Error {
    const runId = main.output?.runId;
    const record = runId === undefined
      ? this.records.at(-1)
      : [...this.records].reverse().find((entry) => entry.runId === runId);
    if (record?.settled?.ok !== true) {
      return new Error("The main request Run finished without a durable result");
    }
    return record.settled.value;
  }

  private async closeRuntime(runtime: CoordinationRuntime): Promise<void> {
    this.ended = true;
    await runtime.close();
    await this.relay;
    await this.ledger?.close();
  }

  private async relayEvents(runtime: CoordinationRuntime): Promise<void> {
    for await (const event of runtime.events) {
      if (event.type === "state.changed") {
        this.refresh(event.snapshot);
      } else if (event.type === "agent.event") {
        this.relayAgentEvent(event.taskId, event.sessionId, event.event);
      } else {
        this.failure ??= new Error(event.message);
      }
    }
  }

  private relayAgentEvent(taskId: string, sessionId: string, event: AgentApplicationEvent): void {
    const host = this.host;
    const task = this.state?.tasks.find((entry) => entry.id === taskId);
    host.emit({
      type: "delegation.event",
      taskId,
      role: task?.role ?? taskId,
      depth: task?.depth ?? 1,
      sessionId,
      event,
    });
    if (event.type === "permission.event") {
      if (event.event.type === "approval.requested") host.trackApproval(event.event.request.id, taskId);
      else host.forgetApproval(event.event.requestId);
    }
  }

  private refresh(snapshot?: CoordinationSnapshot): void {
    if (snapshot !== undefined) this.state = this.project(snapshot);
    if (this.state !== undefined) {
      this.host.emit({ type: "delegation.updated", state: structuredClone(this.state) });
    }
  }

  private project(snapshot: CoordinationSnapshot): MaybeCodeDelegationState {
    const configuration = this.host.options.configuration;
    const changedFiles = this.changedFiles();
    return {
      requestId: this.requestId,
      status: statusOf(snapshot, this.cancelling, this.budgetReason),
      mainRunIds: this.records.map((record) => record.runId),
      startedAt: this.startedAt,
      updatedAt: Date.now(),
      tasks: snapshot.tasks.map((task) => this.host.projectTask(task, snapshot, changedFiles)),
      budget: {
        modelCalls: this.totals.modelCalls,
        totalTokens: this.totals.totalTokens,
        maxModelCalls: configuration.maxModelCalls,
        ...(configuration.maxTotalTokens === undefined ? {} : { maxTotalTokens: configuration.maxTotalTokens }),
        usageComplete: this.usageComplete,
      },
    };
  }

  private async save(): Promise<void> {
    const host = this.host;
    if (this.state === undefined) return;
    const record: MaybeCodeDelegationRequest = {
      requestId: this.requestId,
      status: this.state.status,
      startedAt: this.startedAt,
      ...(this.ended ? { finishedAt: this.state.updatedAt } : {}),
      mainRunIds: this.state.mainRunIds,
      tasks: this.state.tasks,
    };
    host.requests = [
      record,
      ...host.requests.filter((request) => request.requestId !== this.requestId),
    ].slice(0, MAX_INDEXED_REQUESTS);
    await host.options.saveRequests(host.requests);
  }
}

function runIds(snapshot: CoordinationSnapshot): readonly string[] {
  return snapshot.tasks.flatMap((task) => task.output?.runId === undefined ? [] : [task.output.runId]);
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

function statusOf(
  snapshot: CoordinationSnapshot,
  cancelling: string | undefined,
  budgetReason: string | undefined,
): MaybeCodeDelegationState["status"] {
  const tasks = snapshot.tasks;
  if (tasks.some((task) => task.status === "recovery-required")) return "recovery-required";
  if (tasks.some((task) => ["queued", "running", "waiting", "cancelling"].includes(task.status))) return "running";
  if (budgetReason !== undefined) return "failed";
  if (cancelling !== undefined) return "cancelled";
  if (tasks.some((task) => task.status === "failed")) return "failed";
  if (tasks.some((task) => task.status === "cancelled")) return "cancelled";
  return "completed";
}

function failure(
  main: CoordinationTask | undefined,
  runtimeFailure: Error | undefined,
  cancelling: string | undefined,
): Error {
  if (runtimeFailure !== undefined) return runtimeFailure;
  if (main === undefined) return new Error("The request has no main task record");
  if (main.status === "cancelled") return new RunCancelledError(cancelling ?? main.detail ?? "Request cancelled");
  if (main.status === "recovery-required") {
    return new Error(`Sub-agent work needs verified recovery before it can continue: ${main.detail ?? "unknown interrupted tool effects"}`);
  }
  return new Error(`The main request task is ${main.status}: ${main.detail ?? "no durable result"}`);
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
      summary: bounded(
        event.type === "tool.completed" ? describe(event.output) : event.error.message,
        300,
      ),
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

function bounded(text: string, limit: number): string {
  return Buffer.byteLength(text, "utf8") <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
