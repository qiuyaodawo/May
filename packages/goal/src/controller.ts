import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ContextFactory } from "@may/context";
import type { Model, ModelRequest, Tool, Usage } from "@may/core";
import { goalBudget, goalText, restoreGoal } from "./state.js";
import type { GoalAgent, GoalBudget, GoalEvent, GoalOptions, GoalRun, GoalState, GoalStore } from "./types.js";

class GoalLimitError extends Error {}

/** 外部组件独立管理目标；Agent 仅提供通用的执行接口。 */
export class GoalController {
  private state: GoalState | undefined;
  private agent: GoalAgent | undefined;
  private store: GoalStore | undefined;
  private tail: Promise<void> = Promise.resolve();
  private execution: Promise<void> = Promise.resolve();
  private controller: AbortController | undefined;
  private currentRun: GoalRun | undefined;
  private requestedStop: "paused" | "cancelled" | undefined;
  private lastTick = 0;
  private closed = false;
  private storageError: unknown;
  private readonly listeners = new Set<(event: GoalEvent) => void>();

  constructor(private readonly options: GoalOptions = {}) {}

  async attach(agent: GoalAgent, store: GoalStore): Promise<void> {
    if (this.agent || this.closed) throw new Error("GoalController can only be attached once");
    const state = restoreGoal(await store.read(), agent.sessionId);
    this.agent = agent;
    this.store = store;
    this.state = state;
    if (state && (state.status === "active" || state.calls.some(call => call.status === "pending"))) {
      await this.change(current => ({ ...current, status: "paused", reason: "Execution was interrupted; inspect session recovery before resuming.",
        calls: current.calls.map(call => call.status === "pending" ? { ...call, status: "unknown" } : call),
        usage: { ...current.usage,
          elapsedMs: current.usage.elapsedMs + (current.status === "active" ? Math.max(0, Date.now() - current.updatedAt) : 0),
          usageComplete: current.usage.usageComplete && !current.calls.some(call => call.status === "pending") } }));
    }
  }

  get isRunning(): boolean { return this.controller !== undefined; }
  getGoal(): GoalState | undefined { return this.state === undefined ? undefined : structuredClone(this.state); }
  subscribe(listener: (event: GoalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  wait(): Promise<void> { return this.execution; }

  async start(objective: string, budget: GoalBudget = {}): Promise<GoalState> {
    this.assertIdle();
    if (this.state && !["completed", "cancelled"].includes(this.state.status)) throw new Error("Finish or cancel the existing goal before creating another");
    const text = goalText(objective, "objective");
    const limits = goalBudget(budget);
    this.options.validateBudget?.(limits);
    const now = Date.now();
    const state: GoalState = { version: 1, id: randomUUID(), sessionId: this.agent!.sessionId, objective: text,
      status: "active", budget: limits, usage: { runs: 0, totalTokens: 0, elapsedMs: 0, usageComplete: true },
      calls: [], runIds: [], progress: "", createdAt: now, updatedAt: now };
    return this.launch(() => this.commit(state), true);
  }

  async resume(): Promise<GoalState> {
    this.assertIdle();
    const state = this.requireGoal();
    if (!["paused", "blocked", "failed"].includes(state.status)) throw new Error(`Cannot resume a ${state.status} goal`);
    if (state.calls.some(call => call.status !== "settled") && state.budget.maxTotalTokens !== undefined) throw new Error("Goal usage is unknown; reconcileUsage() is required before resuming a token budget");
    this.options.validateBudget?.(state.budget);
    this.checkLimits(state);
    return this.launch(() => this.change(current => {
        const { report: _report, reason: _reason, ...rest } = current;
        return { ...rest, status: "active" };
      }), state.runIds.length === 0);
  }

  /** 同步停止后续调度，异步结果通过 wait() 和目标事件观察。 */
  interrupt(reason = "Paused by user"): boolean {
    if (!this.controller) return false;
    this.requestedStop ??= "paused";
    this.controller.abort(reason);
    this.currentRun?.cancel(reason);
    return true;
  }

  async pause(reason = "Paused by user"): Promise<GoalState> {
    this.assertOpen();
    if (this.interrupt(reason)) await this.execution;
    else if (["blocked", "failed"].includes(this.requireGoal().status)) await this.change(state => ({ ...state, status: "paused", reason }));
    return this.getGoal()!;
  }

  async cancel(): Promise<GoalState> {
    this.assertOpen();
    if (this.controller) {
      this.requestedStop = "cancelled";
      this.controller.abort("Goal cancelled by user");
      this.currentRun?.cancel("Goal cancelled by user");
      await this.execution;
    } else if (!["completed", "cancelled"].includes(this.requireGoal().status)) await this.change(current => ({ ...current, status: "cancelled", reason: "Goal cancelled by user" }));
    return this.getGoal()!;
  }

  async reconcileUsage(callId: string, totalTokens: number): Promise<void> {
    this.assertIdle();
    if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) throw new RangeError("totalTokens must be a non-negative safe integer");
    await this.change(state => {
      const call = state.calls.find(item => item.id === callId);
      if (!call || call.status !== "unknown") throw new Error("Only an unknown call can be reconciled");
      const calls = state.calls.map(item => item.id === callId ? { ...item, status: "settled" as const, tokens: totalTokens } : item);
      return { ...state, calls, usage: { ...state.usage, totalTokens: state.usage.totalTokens + totalTokens - (call.tokens ?? 0), usageComplete: calls.every(item => item.status === "settled" && item.tokens !== undefined) } };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.interrupt("Application closed; resume the goal explicitly after reopening");
    await this.execution;
    await this.tail;
    this.listeners.clear();
  }

  instructions(): string {
    const state = this.state;
    if (!this.isRunning || state?.status !== "active") return "";
    return `An active goal is managed by the host. Continue working across runs until it is complete.\n` +
      `The host has started goal run ${state.usage.runs}. Treat the current run number and current goal state as authoritative. ` +
      `At the beginning of each run, call get_goal for fresh state, then perform the next unfinished work.\n` +
      `Report progress with update_goal. Report completed only with concrete evidence; report blocked when user input or an external prerequisite is required. ` +
      `Completion ends execution at the next complete tool-step boundary. Use the current permissions and user instructions.\n` +
      `Goal: ${JSON.stringify(state.objective)}\nProgress: ${JSON.stringify(state.progress)}\n` +
      `Runs: ${state.usage.runs}/${state.budget.maxRuns ?? "unlimited"}. Tokens: ${state.usage.totalTokens}/${state.budget.maxTotalTokens ?? "unlimited"}.`;
  }

  wrapContextFactory(factory: ContextFactory): ContextFactory {
    return { create: async options => {
      const source = () => [options.instructionsSource?.() ?? options.instructions, this.instructions(), this.continuationInstructions()].filter(Boolean).join("\n\n");
      const managed = await factory.create({ ...options, instructions: source(), instructionsSource: source });
      this.subscribe(() => managed.controller?.invalidateMeasurement?.());
      return managed;
    } };
  }

  private continuationInstructions(): string {
    if (!this.isRunning || this.state?.status !== "active") return "";
    return `Goal execution is active. Current host run: ${this.state.usage.runs}. Continue the unfinished goal now. ` +
      `Read get_goal for current state. Report completed with evidence or blocked with the required user input through update_goal.`;
  }

  private currentRequest(request: ModelRequest): ModelRequest {
    const reminder = this.continuationInstructions();
    let found = false;
    const messages = request.messages.map(message => {
      if (found || message.role !== "system") return message;
      return { ...message, content: message.content.map(part => {
        if (part.type !== "text" || !part.text.endsWith(`\n\n${reminder}`)) return part;
        found = true;
        return { ...part, text: part.text.slice(0, -reminder.length - 2) };
      }) };
    });
    if (!found) throw new Error("Goal execution requires its wrapped ContextFactory instructions");
    // 提示内容已纳入 Context 的估计值，发送时调整位置，保存的消息计数保持不变。
    return { ...request, messages: [...messages, { role: "system", content: [{ type: "text", text: reminder }] }] };
  }

  tools(): readonly Tool[] {
    if (!this.isRunning) return [];
    return createGoalTools(this);
  }

  async report(status: "active" | "completed" | "blocked", evidence: string): Promise<GoalState> {
    this.assertOpen();
    if (!["active", "completed", "blocked"].includes(status)) throw new TypeError("Invalid goal report status");
    if (!this.controller || this.controller.signal.aborted || this.state?.status !== "active") throw new Error("No running goal accepts reports");
    const text = goalText(evidence, "evidence");
    await this.change(state => {
      if (this.controller!.signal.aborted) throw new Error("Goal execution has stopped");
      if (state.report) throw new Error("A terminal goal report is already pending");
      return status === "active" ? { ...state, progress: text } : { ...state, progress: text, report: { status, evidence: text } };
    });
    return this.getGoal()!;
  }

  wrapModel(model: Model): Model {
    const goal = this;
    return {
      ...(model.limits === undefined ? {} : { limits: model.limits }),
      ...(model.contextCompactor === undefined ? {} : { contextCompactor: {
        name: model.contextCompactor.name,
        async compact(snapshot, options) {
          if (goal.isRunning && goal.state?.budget.maxTotalTokens !== undefined) {
            const error = new Error("Native context compaction does not report token usage for goal accounting");
            goal.controller!.abort(error);
            throw error;
          }
          return model.contextCompactor!.compact(snapshot, options);
        },
      } }),
      async *stream(request, options) {
        if (!goal.isRunning) { yield* model.stream(request, options); return; }
        const signal = AbortSignal.any([options.signal, goal.controller!.signal]);
        signal.throwIfAborted();
        const currentRequest = options.runId === undefined ? request : goal.currentRequest(request);
        const id = randomUUID();
        await goal.change(state => {
          goal.checkLimits(state, false);
          if (state.calls.length >= 10_000) throw new GoalLimitError("Goal model call limit reached (10000)");
          return { ...state, calls: [...state.calls, { id, status: "pending", ...(options.runId === undefined ? {} : { runId: options.runId }) }] };
        });
        let settled = false;
        try {
          signal.throwIfAborted();
          for await (const event of model.stream(currentRequest, { ...options, signal })) {
            if (event.type === "retrying") {
              await goal.change(state => ({ ...state,
                calls: [...state.calls, { id: `${id}:retry:${event.attempt}`, status: "unknown" }],
                usage: { ...state.usage, usageComplete: false } }));
              if (goal.state!.budget.maxTotalTokens !== undefined) throw new Error("A retried model request has unknown usage; inspect and reconcile it before continuing a token budget");
            }
            if (event.type === "response.completed") {
              if (settled) throw new Error("Model returned multiple completed responses");
              const tokens = totalTokens(event.usage);
              if (!Number.isSafeInteger(goal.state!.usage.totalTokens + (tokens ?? 0))) throw new Error("Goal token counter exceeds the safe integer limit");
              await goal.change(state => ({ ...state,
                calls: state.calls.map(call => call.id === id ? { ...call, status: tokens === undefined ? "unknown" : "settled", ...(tokens === undefined ? {} : { tokens }) } : call),
                usage: { ...state.usage, totalTokens: state.usage.totalTokens + (tokens ?? 0), usageComplete: state.usage.usageComplete && tokens !== undefined } }));
              settled = true;
              if (tokens === undefined && goal.state!.budget.maxTotalTokens !== undefined) throw new Error("Model did not report usage required by the goal token budget");
              if (goal.state!.budget.maxTotalTokens !== undefined && goal.state!.usage.totalTokens > goal.state!.budget.maxTotalTokens) throw new GoalLimitError("Goal token budget exhausted");
            }
            yield event;
          }
          if (!settled) throw new Error("Model returned no completed response");
        } catch (error) {
          goal.controller?.abort(error);
          throw error;
        } finally {
          if (!settled && goal.storageError === undefined) await goal.change(state => ({ ...state,
            calls: state.calls.map(call => call.id === id ? { ...call, status: "unknown" } : call),
            usage: { ...state.usage, usageComplete: false } }));
        }
      },
    };
  }

  private begin(): void {
    this.controller = new AbortController();
    this.requestedStop = undefined;
    this.lastTick = Date.now();
  }

  private launch(prepare: () => Promise<void>, first: boolean): Promise<GoalState> {
    this.begin();
    const signal = this.controller!.signal;
    let started!: (state: GoalState) => void;
    let failed!: (error: unknown) => void;
    const ready = new Promise<GoalState>((resolve, reject) => { started = resolve; failed = reject; });
    this.execution = (async () => {
      try {
        await prepare();
        started(this.getGoal()!);
        await this.execute(first, signal);
      } catch (error) { failed(error); throw error; }
      finally { this.controller = undefined; this.currentRun = undefined; if (this.state) this.notify(); }
    })();
    // 后台执行错误由 wait() 以及目标状态向宿主报告。
    void this.execution.catch(() => undefined);
    return ready;
  }

  private async execute(first: boolean, signal: AbortSignal): Promise<void> {
    const duration = this.state!.budget.maxDurationMs;
    const timer = duration === undefined ? undefined : setTimeout(
      () => this.controller!.abort(new GoalLimitError("Goal duration budget exhausted")),
      Math.max(1, duration - this.state!.usage.elapsedMs),
    );
    try {
      while (true) {
        signal.throwIfAborted();
        await this.change(state => { this.checkLimits(state); return { ...state, usage: { ...state.usage, runs: state.usage.runs + 1 } }; });
        if (signal.aborted) await this.change(state => ({ ...state, usage: { ...state.usage, runs: state.usage.runs - 1 } }));
        signal.throwIfAborted();
        const options = { signal, shouldYield: () => this.state?.report !== undefined };
        const run = first
          ? await this.agent!.submit({ ...options, input: this.state!.objective })
          : await this.agent!.continue(options);
        first = false;
        this.currentRun = run;
        // 取得 handle 后即观察拒绝，状态写入期间也不会产生未处理的 Promise。
        void run.result.catch(() => undefined);
        try {
          await this.change(state => ({ ...state, runIds: [...state.runIds, run.id] }));
        } catch (error) { run.cancel("Goal state could not be saved"); await run.result.catch(() => undefined); throw error; }
        await run.result;
        this.currentRun = undefined;
        signal.throwIfAborted();
        const report = this.state!.report;
        if (report) {
          if (report.status === "blocked") {
            await this.change(state => ({ ...state, status: "blocked", reason: report.evidence }));
          } else {
            const verified = await this.options.verify?.(this.getGoal()!, signal);
            signal.throwIfAborted();
            if (verified && !verified.completed) {
              const evidence = goalText(verified.evidence, "verification evidence");
              await this.change(state => {
                const { report: _report, ...rest } = state;
                return { ...rest, progress: evidence };
              });
              await nextTurn();
              continue;
            }
            const evidence = goalText(verified?.evidence ?? report.evidence, "completion evidence");
            await this.change(state => ({ ...state, status: "completed", completion: { source: verified ? "verifier" : "model", evidence } }));
          }
          return;
        }
        await nextTurn();
      }
    } catch (caught) {
      const error = signal.aborted ? signal.reason : caught;
      if (this.storageError !== undefined) throw this.storageError;
      const status = this.requestedStop ?? (error instanceof GoalLimitError ? "budget_exhausted" : "failed");
      await this.change(state => ({ ...state, status, reason: String(error instanceof Error ? error.message : error).slice(0, 32_768) || "Goal execution failed" }));
    } finally { clearTimeout(timer); }
  }

  private checkLimits(state: GoalState, runs = true): void {
    if (runs && state.budget.maxRuns !== undefined && state.usage.runs >= state.budget.maxRuns) throw new GoalLimitError("Goal run budget exhausted");
    if (state.budget.maxDurationMs !== undefined && state.usage.elapsedMs >= state.budget.maxDurationMs) throw new GoalLimitError("Goal duration budget exhausted");
    if (state.budget.maxTotalTokens !== undefined && state.usage.totalTokens >= state.budget.maxTotalTokens) throw new GoalLimitError("Goal token budget exhausted");
  }

  private change(update: (state: GoalState) => GoalState): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.storageError !== undefined) throw this.storageError;
      let state = this.requireGoal();
      if (this.isRunning) {
        const now = Date.now();
        state = { ...state, usage: { ...state.usage, elapsedMs: state.usage.elapsedMs + Math.max(0, now - this.lastTick) } };
        this.lastTick = now;
      }
      await this.commit({ ...update(state), updatedAt: Date.now() });
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async commit(state: GoalState): Promise<void> {
    try { await this.store!.write(structuredClone(state)); }
    catch (error) {
      this.storageError = error;
      this.controller?.abort(error);
      this.state = { ...state, status: "failed", reason: "Goal state could not be saved; reopen the session before continuing." };
      this.notify();
      throw error;
    }
    this.state = state;
    this.notify();
  }
  private notify(): void { for (const listener of this.listeners) listener({ type: "goal.changed", goal: this.getGoal()! }); }
  private requireGoal(): GoalState { if (!this.state) throw new Error("No goal has been created"); return this.state; }
  private assertOpen(): void {
    if (this.closed) throw new Error("GoalController is closed");
    if (!this.agent || !this.store) throw new Error("GoalController has not been attached");
    if (this.storageError !== undefined) throw this.storageError;
  }
  private assertIdle(): void {
    this.assertOpen();
    if (this.isRunning || this.agent!.isRunning) throw new Error("An operation is already running");
  }
}

export function createGoalTools(goal: GoalController): readonly Tool[] {
  return [
    { name: "get_goal", description: "Read the active goal, progress and remaining budget.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return modelGoal(goal.getGoal()); } },
    { name: "update_goal", description: "Report progress, completion with evidence, or a blocker requiring user input. Only the host can resume or cancel a goal or change its budget.",
      inputSchema: { type: "object", properties: { status: { type: "string", enum: ["active", "completed", "blocked"] }, evidence: { type: "string" } }, required: ["status", "evidence"], additionalProperties: false },
      async execute(input, context) {
        context.signal.throwIfAborted();
        if (!input || typeof input !== "object") throw new TypeError("Expected a goal report");
        const value = input as Record<string, unknown>;
        if (Object.keys(value).some(key => !["status", "evidence"].includes(key)) || typeof value.status !== "string" || !["active", "completed", "blocked"].includes(value.status)) throw new TypeError("Invalid goal report");
        return modelGoal(await goal.report(value.status as "active" | "completed" | "blocked", goalText(value.evidence, "evidence")));
      } },
  ];
}

function modelGoal(state: GoalState | undefined): Omit<GoalState, "calls" | "runIds"> | undefined {
  if (!state) return undefined;
  const { calls: _calls, runIds: _runIds, ...summary } = state;
  return summary;
}

function totalTokens(usage: Usage | undefined): number | undefined {
  const valid = (value: number | undefined): value is number => value !== undefined && Number.isSafeInteger(value) && value >= 0;
  if (valid(usage?.totalTokens)) return usage.totalTokens;
  if (valid(usage?.inputTokens) && valid(usage?.outputTokens) && Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) return usage.inputTokens + usage.outputTokens;
  return undefined;
}
