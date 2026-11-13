import { randomUUID } from "node:crypto";
import type { AgentApplicationEvent } from "@sortedyuan/may";
import { RunCancelledError, omitUndefined, type RunResult } from "@sortedyuan/may/core";
import { CoordinationRuntime, type CoordinationSnapshot, type CoordinationTask } from "../index.js";
import type { SessionSubmitOptions } from "@sortedyuan/may/session";
import type {
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeRequestRun,
  MaybeCodeRun,
} from "./delegation.js";
import type { SubagentFileGuard } from "./subagent-files.js";
import { SubagentRequestLedger } from "./subagent-budget.js";
import type { SharedBudgetTotals as SubagentBudgetTotals } from "../index.js";
import { MAIN_AGENT, MAIN_TASK_ID, MAX_INDEXED_REQUESTS, bounded } from "./subagent-constants.js";
import type { SubagentHost, SubagentRequestPlan } from "./subagent-host.js";

interface MainRunRecord {
  readonly runId: string;
  readonly turn: number;
  readonly result: Promise<RunResult>;
  settled?: { readonly ok: true; readonly value: RunResult } | { readonly ok: false; readonly error: unknown };
}

/** 一次用户请求：主 Session、它的子任务与请求额度账本。 */
export class SubagentRequest {
  readonly requestId = `req-${randomUUID()}`;
  readonly run: MaybeCodeRun;
  state: MaybeCodeDelegationState | undefined;
  settled: Promise<void> = Promise.resolve();
  runtime: CoordinationRuntime | undefined;
  ledger: SubagentRequestLedger | undefined;
  private totals: SubagentBudgetTotals = {
    modelCalls: 0,
    totalTokens: 0,
    costUsd: 0,
    blocked: false,
    usageComplete: true,
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
  private readonly outcomes: Promise<PromiseSettledResult<unknown>[]>;
  private settlement: Promise<PromiseSettledResult<void>[]> | undefined;
  private relay: Promise<void> | undefined;
  private cancelCommands = 0;
  private cancelling: string | undefined;
  private failure: Error | undefined;
  private backgroundFailure: Error | undefined;
  private ended = false;
  private cancellingPromise: Promise<boolean> | undefined;
  private readonly background = new Set<Promise<void>>();

  constructor(
    readonly host: SubagentHost,
    private readonly plan: SubagentRequestPlan,
    private readonly mode: "submit" | "continue",
  ) {
    this.firstRun = new Promise<string>((resolve, reject) => {
      this.resolveFirstRun = resolve;
      this.rejectFirstRun = reject;
    });
    this.result = new Promise<RunResult>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.outcomes = Promise.allSettled([this.firstRun, this.result]);
    const self = this;
    this.run = {
      get id(): string {
        return self.firstRunId ?? self.requestId;
      },
      requestId: this.requestId,
      result: this.result,
      cancel: (reason?: string) => {
        this.own(this.cancel(reason ?? "Cancelled by user"));
      },
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
    if (this.budgetReason !== undefined) this.own(this.cancel(this.budgetReason));
    return omitUndefined({
      input: this.plan.input,
      runBudget: this.plan.runBudget,
      shouldYield: this.plan.shouldYield,
      signal: this.plan.signal,
      traceAttributes: {
        ...(this.plan.traceAttributes ?? {}),
        "may.request.id": this.requestId,
      },
    });
  }

  observeMainRun(runId: string, turn: number, result: Promise<RunResult>): void {
    const record: MainRunRecord = { runId, turn, result };
    this.records.push(record);
    if (this.firstRunId === undefined) {
      this.firstRunId = runId;
      this.resolveFirstRun(runId);
    }
    this.own(
      result.then(
        async (value) => {
          record.settled = { ok: true, value };
          await this.checkBudget();
          this.refresh();
        },
        (error: unknown) => {
          record.settled = { ok: false, error };
          if (this.failure === undefined && !(error instanceof RunCancelledError)) {
            this.failure = error instanceof Error ? error : new Error(String(error));
          }
          this.refresh();
        },
      ),
    );
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
    return this.records.flatMap((record) =>
      record.settled === undefined
        ? []
        : record.settled.ok
          ? [
              {
                runId: record.runId,
                sessionId: this.host.options.sessionId,
                turn: record.turn,
                result: record.settled.value,
              },
            ]
          : [],
    );
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
    this.cancellingPromise ??= runtime.cancel(`cancel-${this.requestId}-${this.cancelCommands++}`).then(
      () => true,
      (error: unknown) => {
        const failure = asError(error);
        this.failure ??= failure;
        this.backgroundFailure ??= failure;
        return false;
      },
    );
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
    this.budgetReason ??=
      totals.modelCalls > configuration.maxModelCalls
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
    this.ledger = await SubagentRequestLedger.open(
      host.directory(this.requestId),
      this.requestId,
      omitUndefined({
        maxModelCalls: configuration.maxModelCalls,
        maxTotalTokens: configuration.maxTotalTokens,
        reservationTokens: configuration.reservationTokens,
      }),
    );
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
        tasks: [
          {
            id: MAIN_TASK_ID,
            agent: MAIN_AGENT,
            input: bounded(this.plan.record, configuration.limits.maxInputBytes),
          },
        ],
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
    this.own(this.relay);
    this.settled = this.settle(runtime);
    this.settlement = Promise.allSettled([this.settled]);
    this.own(runtime.start());
    await this.firstRun;
  }

  async waitForSettlement(): Promise<void> {
    const results = await this.settlement;
    const failed = results?.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
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
      const failure = asError(error);
      this.failure ??= failure;
      outcome = failure;
    }
    // 先释放宿主再结束请求结果，保证新的用户输入不会遇到活动请求。
    try {
      await this.save();
    } catch (error) {
      outcome = asError(error);
    } finally {
      try {
        await this.host.release(this);
      } catch (error) {
        outcome = asError(error);
      }
    }
    if (outcome instanceof Error) {
      if (this.records.length === 0) this.rejectFirstRun(outcome);
      this.rejectResult(outcome);
    } else {
      this.resolveResult(outcome);
    }
    await this.outcomes;
  }

  private resultOf(main: CoordinationTask): RunResult | Error {
    const runId = main.output?.runId;
    const record =
      runId === undefined ? this.records.at(-1) : [...this.records].reverse().find((entry) => entry.runId === runId);
    if (record?.settled?.ok !== true) {
      return new Error("The main request Run finished without a durable result");
    }
    return record.settled.value;
  }

  private async closeRuntime(runtime: CoordinationRuntime): Promise<void> {
    this.ended = true;
    try {
      await runtime.close();
    } finally {
      try {
        await Promise.all(this.background);
        await this.cancellingPromise;
        await this.relay;
      } finally {
        await this.ledger?.close();
      }
    }
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }

  private own(operation: Promise<unknown>): void {
    const task = operation.then(
      () => {
        this.background.delete(task);
      },
      (error: unknown) => {
        const failure = asError(error);
        this.failure ??= failure;
        this.backgroundFailure ??= failure;
        this.background.delete(task);
      },
    );
    this.background.add(task);
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
      else if (event.event.type === "approval.resolved" || event.event.type === "approval.cancelled") {
        host.forgetApproval(event.event.requestId);
      }
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
      budget: omitUndefined({
        modelCalls: this.totals.modelCalls,
        totalTokens: this.totals.totalTokens,
        maxModelCalls: configuration.maxModelCalls,
        maxTotalTokens: configuration.maxTotalTokens,
        usageComplete: this.usageComplete,
      }),
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
    host.requests = [record, ...host.requests.filter((request) => request.requestId !== this.requestId)].slice(
      0,
      MAX_INDEXED_REQUESTS,
    );
    await host.options.saveRequests(host.requests);
  }
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
    return new Error(
      `Sub-agent work needs verified recovery before it can continue: ${main.detail ?? "unknown interrupted tool effects"}`,
    );
  }
  return new Error(`The main request task is ${main.status}: ${main.detail ?? "no durable result"}`);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
