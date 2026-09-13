import { randomUUID } from "node:crypto";
import { AsyncStateSerializer } from "@may/application";
import { AsyncEventQueue } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type {
  CoordinationAgent, CoordinationEvent, CoordinationJournal, CoordinationLimits, CoordinationPolicy,
  CoordinationSnapshot, CoordinationStore, CoordinationTask, HandoffSpec, TaskController, TaskExecution, TaskGraphChange, TaskMessageSpec, TaskOutput, TaskRecovery, TaskSpec,
} from "./types.js";
import { canonical, copy, freeze, limits, name, validateGraph, validateHandoff, validateMessage, validateOutput, validateSnapshot } from "./validation.js";

export interface CoordinationRuntimeOptions {
  readonly id: string;
  readonly store: CoordinationStore;
  readonly agents: Readonly<Record<string, CoordinationAgent>>;
  readonly policy: CoordinationPolicy;
}

export interface CreateCoordinationOptions extends CoordinationRuntimeOptions {
  readonly tasks: readonly TaskSpec[];
  readonly limits?: Partial<CoordinationLimits>;
}

interface ActiveTask { readonly controller: AbortController; readonly done: Promise<void> }

/** Task graphs and bounded delegation on one host. Opening never executes agents. */
export class CoordinationRuntime {
  readonly events: AsyncIterable<CoordinationEvent>;
  private readonly serial = new AsyncStateSerializer();
  private readonly queue = new AsyncEventQueue<CoordinationEvent>({
    maxBufferedValues: 1024,
    isDroppable: () => true, // Durable state/history remain available through inspection.
  });
  private readonly active = new Map<string, ActiveTask>();
  private readonly cancellationDeliveries = new Set<string>();
  private readonly waiters = new Set<{ resolve: (snapshot: CoordinationSnapshot) => void; reject: (error: Error) => void }>();
  private readonly agents: ReadonlyMap<string, CoordinationAgent>;
  private readonly policy: CoordinationPolicy;
  private state: CoordinationSnapshot;
  private started = false;
  private closing = false;
  private closePromise: Promise<void> | undefined;
  private fatal: Error | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  private constructor(options: CoordinationRuntimeOptions, private readonly journal: CoordinationJournal, state: CoordinationSnapshot) {
    this.state = freeze(copy(state));
    // Snapshot callbacks as well as versions; registry mutation cannot change live authority.
    this.agents = new Map(Object.entries(options.agents).map(([key, agent]) => [key, Object.freeze({
      version: agent.version, execute: agent.execute.bind(agent), recover: agent.recover.bind(agent),
      ...(agent.cancel === undefined ? {} : { cancel: agent.cancel.bind(agent) }),
      ...(agent.resolveApproval === undefined ? {} : { resolveApproval: agent.resolveApproval.bind(agent) }),
    })]));
    this.policy = Object.freeze({ version: options.policy.version, authorize: options.policy.authorize.bind(options.policy),
      ...(options.policy.authorizeDelegation === undefined ? {} : { authorizeDelegation: options.policy.authorizeDelegation.bind(options.policy) }),
      ...(options.policy.authorizeMessage === undefined ? {} : { authorizeMessage: options.policy.authorizeMessage.bind(options.policy) }),
      ...(options.policy.authorizeHandoff === undefined ? {} : { authorizeHandoff: options.policy.authorizeHandoff.bind(options.policy) }),
      ...(options.policy.authorizeRetry === undefined ? {} : { authorizeRetry: options.policy.authorizeRetry.bind(options.policy) }),
      ...(options.policy.authorizeGraphRewrite === undefined ? {} : { authorizeGraphRewrite: options.policy.authorizeGraphRewrite.bind(options.policy) }),
    });
    this.events = this.queue;
  }

  static async create(options: CreateCoordinationOptions): Promise<CoordinationRuntime> {
    options = captureOptions(options);
    name(options.id, "coordination id"); name(options.policy.version, "policy version");
    const budget = limits(options.limits);
    const tasks = copy(options.tasks);
    validateGraph(tasks, budget.maxTasks, budget.maxInputBytes);
    const state: CoordinationSnapshot = {
      format: 1, id: options.id, revision: 1, policyVersion: options.policy.version, limits: budget,
      tasks: tasks.map((task) => {
        const agent = options.agents[task.agent];
        if (!Object.hasOwn(options.agents, task.agent) || !agent) throw new Error(`Unknown agent: ${task.agent}`);
        name(agent.version, "agent version");
        return { id: task.id, agent: task.agent, input: task.input, dependsOn: [...(task.dependsOn ?? [])],
          agentVersion: agent.version, dispatchId: randomUUID(), sessionId: randomUUID(), turn: 0, status: "queued" };
      }), commands: {},
    };
    const journal = await options.store.acquire(options.id);
    try {
      if (await journal.read() !== undefined) throw new Error("Coordination already exists; use resume");
      const runtime = new CoordinationRuntime(options, journal, state);
      for (const task of runtime.state.tasks) {
        if (await runtime.policy.authorize(task, state.id) !== true) throw new Error(`Task authorization denied: ${task.id}`);
      }
      await journal.commit(state, 0);
      return runtime;
    } catch (error) { await journal.close(); throw error; }
  }

  static async resume(options: CoordinationRuntimeOptions): Promise<CoordinationRuntime> {
    options = captureOptions(options);
    const journal = await options.store.acquire(options.id);
    try {
      const state = await journal.read();
      if (state === undefined) throw new Error("Coordination does not exist");
      validateSnapshot(state, options.id);
      if (state.policyVersion !== options.policy.version) throw new Error("Coordination policy version changed");
      for (const task of [...state.tasks, ...(state.graphChanges ?? []).flatMap((revision) => revision.previous), ...state.tasks.flatMap((task) => (task.attempts ?? []).map((attempt) => attempt.task))]) {
        for (const owner of [task, ...(task.pendingHandoff ? [task.pendingHandoff] : []), ...(task.handoffs ?? []).flatMap(({ from, to }) => [from, to])]) {
          if (!Object.hasOwn(options.agents, owner.agent) || options.agents[owner.agent]?.version !== owner.agentVersion) {
            throw new Error(`Agent missing or version changed: ${owner.agent}`);
          }
        }
      }
      const runtime = new CoordinationRuntime(options, journal, state);
      // Read-only reconciliation of dispatched tasks. Never execute or re-submit inputs here.
      for (const task of state.tasks) {
        if (!["running", "cancelling", "recovery-required"].includes(task.status)) continue;
        await runtime.applyRecovery(task.id, await runtime.recover(task), true);
      }
      return runtime;
    } catch (error) { await journal.close(); throw error; }
  }

  snapshot(): CoordinationSnapshot { return freeze(copy(this.state)); }

  start(): Promise<void> {
    return this.serial.run(async () => {
      this.assertOpen();
      if (this.state.startedAt === undefined) await this.save({ ...this.state, startedAt: Date.now() });
      this.started = true;
      if (this.deadline === undefined && this.state.limits.maxDurationMs !== undefined && !this.state.stopReason) {
        const remaining = this.state.startedAt! + this.state.limits.maxDurationMs - Date.now();
        if (remaining > 0) this.deadline = setTimeout(() => {
          void this.serial.run(() => this.stopAll("Coordination deadline exceeded")).catch((error) => this.fail(error));
        }, remaining);
      }
      await this.pump();
    });
  }

  /** Resolves at quiescence, including recovery-blocked graphs; inspect task statuses. */
  async wait(): Promise<CoordinationSnapshot> {
    await this.start();
    return new Promise((resolve, reject) => {
      // Observe quiescence only between complete scheduler transitions, not while
      // a finished task has released its slot and its dependant is being persisted.
      void this.serial.run(() => {
        this.assertOpen();
        if (this.active.size === 0) resolve(this.snapshot());
        else this.waiters.add({ resolve, reject });
      }).catch(reject);
    });
  }

  /** Cancels one task, or the entire graph when taskId is omitted. */
  cancel(commandId: string, taskId?: string): Promise<void> {
    return this.serial.run(async () => {
      this.assertOpen(); name(commandId, "command id");
      const payload = canonical({ type: "cancel", taskId: taskId ?? null });
      if (this.duplicate(commandId, payload)) { await this.cancelDetachedExecutions(true); await this.pump(); return; }
      if (taskId !== undefined) this.task(taskId);
      const next = this.cancelState(taskId, "Cancelled by host");
      await this.save({ ...next, commands: { ...next.commands, [commandId]: payload } });
      this.abortCancelled();
      await this.cancelDetachedExecutions(true);
      await this.pump();
    });
  }

  /** Host reconciliation records a verified terminal outcome, never retries work. */
  resolveRecovery(commandId: string, taskId: string, finding: string,
    outcome: Extract<TaskRecovery, { status: "completed" | "failed" | "cancelled" }>): Promise<void> {
    // Normalize before queuing so caller mutation cannot change the accepted command.
    const resolution = copy(outcome);
    return this.serial.run(async () => {
      this.assertOpen(); name(commandId, "command id");
      if (typeof finding !== "string" || !finding.trim()) throw new Error("Verified recovery finding is required");
      if (!["completed", "failed", "cancelled"].includes(resolution.status)) throw new Error("Recovery must record a terminal outcome");
      const payload = canonical({ type: "resolve", taskId, finding, outcome: resolution });
      if (this.duplicate(commandId, payload)) return;
      if (this.task(taskId).status !== "recovery-required") throw new Error("Task does not require recovery");
      const { waitFor: _wait, waitForMessages: _messages, pendingHandoff: _handoff, ...verified } = this.task(taskId);
      const task = this.recoveredTask(verified, resolution, false);
      await this.save({ ...this.replace({ ...task, detail: finding }), commands: { ...this.state.commands, [commandId]: payload } });
      await this.pump();
    });
  }

  async resolveApproval(taskId: string, requestId: string, decision: ApprovalDecision): Promise<boolean> {
    this.assertOpen();
    const task = this.task(taskId);
    if (!this.active.has(taskId) || task.status !== "running") return false;
    return await this.agents.get(task.agent)!.resolveApproval?.(task.sessionId, requestId, decision) ?? false;
  }

  /** Explicitly authorizes a new attempt; does not retry any uncertain execution. */
  retryTask(commandId: string, taskId: string, finding: string): Promise<void> {
    return this.serial.run(async () => {
      this.assertOpen(); name(commandId, "command id");
      if (typeof finding !== "string" || !finding.trim() || Buffer.byteLength(finding, "utf8") > this.state.limits.maxOutputBytes) throw new Error("A bounded verified retry finding is required");
      const payload = canonical({ type: "retry", taskId, finding });
      if (this.duplicate(commandId, payload)) return;
      this.assertHostMutationAllowed();
      const task = this.task(taskId);
      if (!["failed", "cancelled"].includes(task.status) || this.active.has(taskId)) throw new Error("Only a verified failed/cancelled task can be retried; reconcile unknown effects first");
      if ((task.attempt ?? 0) + 1 >= (this.state.limits.maxAttempts ?? 3)) throw new Error("Task exceeds maxAttempts");
      if ((task.turn ?? 0) + 1 >= (this.state.limits.maxTaskTurns ?? 16)) throw new Error("No task turn remains for retry");
      if (task.parentTaskId !== undefined && this.task(task.parentTaskId).status !== "waiting") throw new Error("A delegated task can only retry while its parent is still waiting");
      if (this.pendingMessages(taskId).length) throw new Error("Retry cannot transfer unreceived messages to a new attempt");
      const descendants = new Set([taskId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const child of this.state.tasks) if (child.parentTaskId && descendants.has(child.parentTaskId) && !descendants.has(child.id)) { descendants.add(child.id); changed = true; }
      }
      if (this.state.tasks.some((child) => child.id !== taskId && descendants.has(child.id) && (!["completed", "failed", "cancelled"].includes(child.status) || this.active.has(child.id)))) throw new Error("Retry requires all owned descendants to have verified terminal outcomes");
      if (this.state.tasks.some((consumer) => consumer.wakeFrom?.includes(taskId) || (consumer.dependsOn.includes(taskId) && (consumer.inbox !== undefined || (consumer.turn ?? 0) > 0 || consumer.attempts?.length)))) throw new Error("Task outcome has already been reserved or submitted to a consumer");
      if (await this.policy.authorizeRetry?.(task, finding, this.state.id) !== true || await this.policy.authorize(taskSpec(task), this.state.id) !== true) throw new Error("Retry authorization denied");
      this.assertHostMutationAllowed();
      const { attempts = [], ...previous } = task;
      const turn = (task.turn ?? 0) + 1;
      const next: CoordinationTask = { ...taskSpec(task), dependsOn: [...task.dependsOn], agentVersion: task.agentVersion,
        dispatchId: randomUUID(), sessionId: randomUUID(), turn, sessionStartTurn: turn,
        attempt: (task.attempt ?? 0) + 1, attemptStartTurn: turn, attempts: [...attempts, { commandId, finding, task: previous }], status: "queued",
        ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
        ...(task.createdByCommand === undefined ? {} : { createdByCommand: task.createdByCommand }),
      };
      await this.save({ ...this.replace(next), commands: { ...this.state.commands, [commandId]: payload } });
      await this.pump();
    });
  }

  /** Atomic host-only graph editing. Submitted nodes and their identities are immutable. */
  rewriteGraph(commandId: string, requested: TaskGraphChange): Promise<void> {
    const change = freeze(copy(requested));
    return this.serial.run(async () => {
      this.assertOpen(); name(commandId, "command id");
      if (!change || typeof change !== "object" || Object.keys(change).some((key) => !["add", "update", "remove"].includes(key))) throw new Error("Graph change accepts only add, update and remove");
      for (const value of [change.add, change.update, change.remove]) if (value !== undefined && !Array.isArray(value)) throw new Error("Graph change operations must be arrays");
      const add = change.add ?? [], update = change.update ?? [], remove = change.remove ?? [];
      const ids = [...add.map((task) => task.id), ...update.map((task) => task.id), ...remove];
      for (const id of ids) name(id, "changed task id");
      if (!ids.length || ids.length > this.state.limits.maxTasks || new Set(ids).size !== ids.length) throw new Error("Graph change must contain bounded distinct task ids");
      const payload = canonical({ type: "rewrite-graph", change });
      if (this.duplicate(commandId, payload)) return;
      this.assertHostMutationAllowed();
      if ((this.state.graphChanges?.length ?? 0) >= (this.state.limits.maxGraphChanges ?? 32)) throw new Error("Coordination exceeds maxGraphChanges");
      const oldIds = new Set((this.state.graphChanges ?? []).flatMap((revision) => revision.previous.map((task) => task.id)));
      for (const spec of add) if (this.state.tasks.some((task) => task.id === spec.id) || oldIds.has(spec.id)) throw new Error(`Task id already exists in graph history: ${spec.id}`);
      const touched = new Set([...update.map((task) => task.id), ...remove]);
      const previous = [...touched].map((id) => this.task(id));
      for (const task of previous) {
        if (task.status !== "queued" || task.parentTaskId !== undefined || task.createdByCommand !== undefined || (task.turn ?? 0) !== 0 || task.inbox !== undefined || task.cancelRequested || task.output || task.waitFor || task.waitForMessages || task.pendingHandoff || task.handoffs?.length || task.attempts?.length || this.active.has(task.id)) throw new Error(`Only pristine queued top-level tasks may be rewritten: ${task.id}`);
        if (this.state.tasks.some((other) => other.parentTaskId === task.id || other.waitFor?.includes(task.id) || other.wakeFrom?.includes(task.id)) || this.state.messages?.some((message) => message.fromTaskId === task.id || message.toTaskId === task.id)) throw new Error(`Task has durable ownership, wait or mailbox references: ${task.id}`);
        if ((await this.recover(task)).status !== "not-started") throw new Error(`Task has submitted or uncertain execution history: ${task.id}`);
      }
      // Lifetime task quota counts removed nodes too, so edits cannot recycle the quota.
      const removedCount = (this.state.graphChanges ?? []).reduce((sum, revision) => sum + (revision.change.remove?.length ?? 0), 0);
      if (this.state.tasks.length + removedCount + add.length > this.state.limits.maxTasks) throw new Error("Graph change exceeds the lifetime maxTasks quota");
      const specs = [...this.state.tasks.filter((task) => !touched.has(task.id)), ...add, ...update];
      validateGraph(specs, this.state.limits.maxTasks, this.state.limits.maxInputBytes);
      if (await this.policy.authorizeGraphRewrite?.(change, this.snapshot()) !== true) throw new Error("Graph rewrite authorization denied");
      const fresh = new Map<string, CoordinationTask>();
      for (const spec of [...add, ...update]) {
        const agent = this.agents.get(spec.agent);
        if (!agent) throw new Error(`Unknown agent: ${spec.agent}`);
        if (await this.policy.authorize(spec, this.state.id) !== true) throw new Error(`Task authorization denied: ${spec.id}`);
        fresh.set(spec.id, { id: spec.id, agent: spec.agent, input: spec.input, dependsOn: [...(spec.dependsOn ?? [])],
          agentVersion: agent.version, dispatchId: randomUUID(), sessionId: randomUUID(), turn: 0, status: "queued" });
      }
      this.assertHostMutationAllowed();
      await this.save({ ...this.state, tasks: [...this.state.tasks.filter((task) => !remove.includes(task.id)).map((task) => fresh.get(task.id) ?? task), ...add.map((spec) => fresh.get(spec.id)!)],
        graphChanges: [...(this.state.graphChanges ?? []), { commandId, change, previous }], commands: { ...this.state.commands, [commandId]: payload },
      });
      await this.pump();
    });
  }

  /** Stops scheduling, cancels active executions, then releases journal ownership. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      if (this.deadline !== undefined) clearTimeout(this.deadline);
      await this.serial.run(async () => {
        this.started = false;
        if (!this.fatal) {
          const tasks = this.state.tasks.map((task) => this.active.has(task.id) || (this.agents.get(task.agent)!.cancel !== undefined && ["running", "cancelling", "recovery-required"].includes(task.status))
            ? { ...task, status: task.status === "recovery-required" ? "recovery-required" as const : "cancelling" as const, cancelRequested: true, detail: "Runtime closed" } : task);
          if (tasks.some((task, index) => task !== this.state.tasks[index])) await this.save({ ...this.state, tasks });
          await this.cancelDetachedExecutions(true);
        }
      }).catch((error) => this.fail(error));
      for (const active of this.active.values()) active.controller.abort("Runtime closed");
      await Promise.all([...this.active.values()].map((active) => active.done));
      if (!this.fatal) await this.serial.run(() => this.cancelDetachedExecutions()).catch((error) => this.fail(error));
      await this.serial.close();
      await this.journal.close();
      this.notifyIdle(); this.queue.close();
    })();
    return this.closePromise;
  }

  private async pump(): Promise<void> {
    if (!this.started || this.closing || this.fatal) { this.notifyIdle(); return; }
    await this.cancelDetachedExecutions();
    if (!this.state.stopReason && this.state.limits.maxDurationMs !== undefined &&
      Date.now() >= this.state.startedAt! + this.state.limits.maxDurationMs) {
      await this.stopAll("Coordination deadline exceeded"); return;
    }
    if (this.deadline === undefined && this.state.limits.maxDurationMs !== undefined && !this.state.stopReason) {
      this.deadline = setTimeout(() => { void this.serial.run(() => this.stopAll("Coordination deadline exceeded")).catch((error) => this.fail(error)); }, this.state.startedAt! + this.state.limits.maxDurationMs - Date.now());
    }
    // Fail static dependants and cancel descendants of failed/cancelled owners.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.state.tasks) {
        if (task.parentTaskId !== undefined && ["completed", "failed", "cancelled"].includes(this.task(task.parentTaskId).status) &&
          !["completed", "failed", "cancelled"].includes(task.status) && !task.cancelRequested) {
          await this.save(this.cancelState(task.id, "Parent task is terminal"));
          this.abortCancelled(); await this.cancelDetachedExecutions(); changed = true; continue;
        }
        if (task.status === "queued" && task.dependsOn.some((id) => ["failed", "cancelled"].includes(this.task(id).status))) {
          await this.save(this.replace({ ...task, status: "failed", detail: "Dependency did not complete successfully" }));
          changed = true;
        }
      }
    }
    // Wakeups are committed before dispatch, with a stable input identity for the next turn.
    for (const task of this.state.tasks) {
      if (task.status !== "waiting") continue;
      const ready = task.waitForMessages === true
        ? this.pendingMessages(task.id).length > 0
        : task.waitFor?.every((id) => ["completed", "failed", "cancelled"].includes(this.task(id).status));
      if (!ready) continue;
      if ((task.turn ?? 0) + 1 >= (this.state.limits.maxTaskTurns ?? 16)) {
        await this.save(this.replace({ ...task, status: "failed", detail: "Task turn limit reached" }));
        await this.pump(); return;
      }
      const { waitFor, waitForMessages: _messages, inbox: _inbox, wakeFrom: _wake, ...rest } = task;
      await this.save(this.replace({ ...rest, status: "queued", turn: (task.turn ?? 0) + 1,
        ...(waitFor === undefined ? {} : { wakeFrom: waitFor }) }));
    }
    while (!this.state.stopReason && this.active.size < this.state.limits.maxConcurrent) {
      const task = this.state.tasks.find((task) => task.status === "queued" && task.dependsOn.every((id) => this.task(id).status === "completed") &&
        (task.parentTaskId === undefined || ["running", "waiting"].includes(this.task(task.parentTaskId).status)));
      if (!task) break;
      let allowed = false;
      try {
        allowed = await this.policy.authorize(freeze(copy(task)), this.state.id) === true;
        if (task.parentTaskId !== undefined) allowed &&= await this.policy.authorizeDelegation?.(this.task(task.parentTaskId), task, this.state.id) === true;
        const handoff = latestHandoff(task);
        if (handoff) allowed &&= await this.policy.authorizeHandoff?.(handoff.from, taskSpec(task), handoff.input, this.state.id) === true;
        const retry = task.attempts?.at(-1);
        if (retry) allowed &&= await this.policy.authorizeRetry?.(retry.task, retry.finding, this.state.id) === true;
      } catch { /* deny closed */ allowed = false; }
      if (this.closing) break;
      if (this.state.limits.maxDurationMs !== undefined && Date.now() >= this.state.startedAt! + this.state.limits.maxDurationMs) {
        await this.stopAll("Coordination deadline exceeded"); return;
      }
      if (!allowed) {
        await this.save(this.replace({ ...task, status: "failed", detail: "Task authorization denied" }));
        // Also propagate the failure to queued descendants.
        await this.pump(); return;
      }
      // This acknowledged record is the dispatch intent. execute starts only afterwards.
      const inbox = task.inbox ?? this.pendingMessages(task.id).map((message) => message.id);
      const running = { ...task, inbox, status: "running" as const };
      await this.save({ ...this.replace(running), messages: (this.state.messages ?? []).map((message) =>
        inbox.includes(message.id) ? { ...message, deliveredTurn: task.turn ?? 0 } : message) });
      this.launch(running);
    }
    this.notifyIdle();
  }

  private launch(task: CoordinationTask): void {
    const controller = new AbortController();
    const agent = this.agents.get(task.agent)!;
    const execution = this.execution(task);
    const done = Promise.resolve().then(async () => {
      let outcome: TaskRecovery;
      try {
        if (this.state.limits.maxDurationMs !== undefined && Date.now() >= this.state.startedAt! + this.state.limits.maxDurationMs) controller.abort("Coordination deadline exceeded");
        controller.signal.throwIfAborted();
        const output = await agent.execute(execution, { signal: controller.signal,
          delegate: (commandId, tasks) => this.delegate(task.id, task.turn ?? 0, commandId, tasks),
          sendMessage: (commandId, message) => this.sendMessage(task.id, task.turn ?? 0, commandId, message),
          waitForMessages: (commandId) => this.waitForMessages(task.id, task.turn ?? 0, commandId),
          handoff: (commandId, spec) => this.handoff(task.id, task.turn ?? 0, commandId, spec),
          report: (event) => {
            if (!this.fatal) this.queue.push({ type: "agent.event", taskId: task.id, sessionId: task.sessionId, event: freeze(copy(event)) });
          },
        });
        outcome = "yielded" in output && output.yielded === true ? { status: "yielded" }
          : { status: "completed", output: validateOutput(output as TaskOutput, this.state.limits.maxOutputBytes) };
      } catch {
        // An exception alone does not establish whether effects happened.
        outcome = await this.recover(task);
        if (outcome.status === "not-started") outcome = {
          status: controller.signal.aborted ? "cancelled" : "failed", detail: "Execution stopped before any durable input was submitted",
        };
      }
      await this.serial.run(async () => {
        try { if (!this.fatal) await this.applyRecovery(task.id, outcome, false); }
        finally { this.active.delete(task.id); }
        await this.pump();
      });
    }).catch((error) => { this.active.delete(task.id); this.fail(error); this.notifyIdle(); });
    this.active.set(task.id, { controller, done });
  }

  private execution(task: CoordinationTask): TaskExecution {
    return freeze(copy({ coordinationId: this.state.id, task,
      dependencies: task.dependsOn.map((id) => ({ taskId: id, output: this.task(id).output! })),
      messages: (this.state.messages ?? []).filter((message) => task.inbox?.includes(message.id)),
      ...(task.wakeFrom === undefined ? {} : { wakeResults: task.wakeFrom.map((id) => {
        const child = this.task(id);
        return { taskId: id, status: child.status, ...(child.output === undefined ? {} : { output: child.output }), ...(child.detail === undefined ? {} : { detail: child.detail }) };
      }) }),
      ...(this.state.limits.runBudget === undefined ? {} : { runBudget: this.state.limits.runBudget }),
    }));
  }

  private async recover(task: CoordinationTask): Promise<TaskRecovery> {
    try { return await this.agents.get(task.agent)!.recover(this.execution(task)); }
    catch (error) { return { status: "recovery-required", detail: `Cannot establish durable outcome: ${message(error)}` }; }
  }

  private recoveredTask(task: CoordinationTask, outcome: TaskRecovery, allowNotStarted: boolean): CoordinationTask {
    if (outcome.status === "yielded") {
      if (task.cancelRequested) return { ...task, status: "cancelled" };
      if (task.pendingHandoff) return this.transfer(task);
      if (!task.waitFor?.length && !task.waitForMessages) throw new Error("Agent yielded without a durable wait condition");
      return { ...task, status: "waiting" };
    }
    if (outcome.status === "completed") {
      if ((task.waitFor?.length || task.waitForMessages || task.pendingHandoff) && !task.cancelRequested) throw new Error("Agent completed despite a pending wait/handoff; inspect the durable boundary");
      return { ...task, status: task.cancelRequested ? "cancelled" : "completed",
        output: validateOutput(outcome.output, this.state.limits.maxOutputBytes),
        ...(task.cancelRequested ? { detail: "Cancellation requested; execution nevertheless returned a result" } : {}),
      };
    }
    if (outcome.status === "not-started" && allowNotStarted) {
      if (task.waitFor?.length || task.waitForMessages || task.pendingHandoff || this.state.messages?.some((message) => message.fromTaskId === task.id && message.fromTurn === (task.turn ?? 0))) {
        throw new Error("Durable task commands exist but their input history is missing; do not replay the task");
      }
      return { ...task, status: task.cancelRequested ? "cancelled" : "queued" };
    }
    if (outcome.status === "failed" || outcome.status === "cancelled" || outcome.status === "recovery-required") {
      return { ...task, status: outcome.status, detail: outcome.detail };
    }
    throw new Error("Invalid recovery outcome");
  }

  private async applyRecovery(taskId: string, outcome: TaskRecovery, allowNotStarted: boolean): Promise<void> {
    const task = this.task(taskId);
    let next: CoordinationTask;
    try { next = this.recoveredTask(task, outcome, allowNotStarted); }
    catch (error) { next = { ...task, status: "recovery-required", detail: message(error) }; }
    await this.save(this.replace(next));
  }

  private async stopAll(reason: string): Promise<void> {
    if (this.fatal || this.closing || this.state.stopReason) return;
    await this.save(this.cancelState(undefined, reason));
    this.abortCancelled(); await this.cancelDetachedExecutions(); this.notifyIdle();
  }

  private cancelState(taskId: string | undefined, reason: string): CoordinationSnapshot {
    const selected = new Set(taskId === undefined ? this.state.tasks.map((task) => task.id) : [taskId]);
    // Ownership cancellation cascades independently of DAG dependencies.
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.state.tasks) if (task.parentTaskId !== undefined && selected.has(task.parentTaskId) && !selected.has(task.id)) { selected.add(task.id); changed = true; }
    }
    return { ...this.state, ...(taskId === undefined ? { stopReason: reason } : {}), tasks: this.state.tasks.map((task) => {
      if (!selected.has(task.id)) return task;
      if (["completed", "failed", "cancelled"].includes(task.status)) return task;
      return { ...task, status: task.status === "queued" || task.status === "waiting" ? "cancelled" : task.status === "recovery-required" ? "recovery-required" : "cancelling",
        cancelRequested: true, detail: reason };
    }) };
  }

  private abortCancelled(): void {
    for (const [id, active] of this.active) if (this.task(id).cancelRequested) active.controller.abort(this.task(id).detail);
  }

  /** A persisted intent may outlive its local execute promise after a transport failure. */
  private async cancelDetachedExecutions(force = false): Promise<void> {
    for (const previous of this.state.tasks) {
      const task = this.task(previous.id), agent = this.agents.get(task.agent)!;
      if (!task.cancelRequested || this.active.has(task.id) || !agent.cancel || ["completed", "failed"].includes(task.status)) continue;
      // Pristine queued nodes were never dispatched. No remote cancellation is needed.
      if (task.status === "cancelled" && task.inbox === undefined) continue;
      const identity = `${task.dispatchId}:${task.turn ?? 0}`;
      if (!force && this.cancellationDeliveries.has(identity)) continue;
      this.cancellationDeliveries.add(identity);
      try { await agent.cancel(this.execution(task)); }
      catch (error) {
        // A failed control delivery cannot prove that an externally owned job stopped.
        await this.save(this.replace({ ...task, status: "recovery-required", detail: `Cancellation delivery is unconfirmed: ${message(error)}` }));
      }
    }
  }

  private duplicate(commandId: string, payload: string): boolean {
    if (!Object.hasOwn(this.state.commands, commandId)) return false;
    if (this.state.commands[commandId] !== payload) throw new Error("Command id was reused with different input");
    return true;
  }

  /** Only reachable through a capability bound to an active task and turn. */
  private delegate(parentId: string, turn: number, commandId: string, specs: readonly TaskSpec[]): Promise<{ taskIds: readonly string[] }> {
    const children = copy(specs);
    return this.serial.run(async () => {
      this.assertOpen(); name(commandId, "command id");
      const parent = this.task(parentId);
      if (!this.active.has(parentId) || parent.status !== "running" || parent.cancelRequested || (parent.turn ?? 0) !== turn) throw new Error("Delegation capability is no longer active");
      const payload = canonical({ type: "delegate", parentId, turn, children });
      if (this.duplicate(commandId, payload)) return { taskIds: children.map((task) => task.id) };
      if (parent.pendingHandoff) throw new Error("Task has a pending handoff");
      if (parent.waitForMessages) throw new Error("Cannot combine a child wait with a message wait in one turn");
      if ((parent.turn ?? 0) + 1 >= (this.state.limits.maxTaskTurns ?? 16)) throw new Error("No task turn remains to receive delegated results");
      let depth = 0;
      let ancestor: CoordinationTask | undefined = parent;
      while (ancestor) { depth++; ancestor = ancestor.parentTaskId === undefined ? undefined : this.task(ancestor.parentTaskId); }
      if (depth > (this.state.limits.maxDepth ?? 4)) throw new Error("Delegation exceeds maxDepth");
      validateGraph(children, this.state.limits.maxTasks, this.state.limits.maxInputBytes);
      if (children.some((task) => task.dependsOn?.length)) throw new Error("Delegated children must be independent; parent waits must not create dependency cycles");
      const graphHistory = this.state.graphChanges ?? [];
      if (this.state.tasks.length + graphHistory.reduce((sum, revision) => sum + (revision.change.remove?.length ?? 0), 0) + children.length > this.state.limits.maxTasks) throw new Error("Delegation exceeds the lifetime maxTasks quota");
      if (children.some((child) => graphHistory.some((revision) => revision.previous.some((old) => old.id === child.id)))) throw new Error("Delegation cannot reuse a historical task id");
      validateGraph([...this.state.tasks, ...children], this.state.limits.maxTasks, this.state.limits.maxInputBytes);
      const records: CoordinationTask[] = [];
      for (const child of children) {
        const agent = this.agents.get(child.agent);
        if (!agent) throw new Error(`Unknown agent: ${child.agent}`);
        const safeChild = freeze(copy(child));
        if (await this.policy.authorizeDelegation?.(parent, safeChild, this.state.id) !== true ||
          await this.policy.authorize(safeChild, this.state.id) !== true) throw new Error(`Delegation authorization denied: ${child.id}`);
        records.push({ id: child.id, agent: child.agent, input: child.input, dependsOn: [], parentTaskId: parentId,
          createdByCommand: commandId, agentVersion: agent.version, dispatchId: randomUUID(), sessionId: randomUUID(), turn: 0, status: "queued" });
      }
      if (this.closing || this.active.get(parentId)?.controller.signal.aborted) throw new Error("Delegation cancelled before commit");
      if (this.state.limits.maxDurationMs !== undefined && Date.now() >= this.state.startedAt! + this.state.limits.maxDurationMs) throw new Error("Coordination deadline exceeded before delegation commit");
      const updated = { ...parent, waitFor: [...(parent.waitFor ?? []), ...records.map((task) => task.id)] };
      await this.save({ ...this.replace(updated), tasks: [...this.replace(updated).tasks, ...records], commands: { ...this.state.commands, [commandId]: payload } });
      // The parent still owns its slot until Core has durably yielded a complete step.
      return { taskIds: records.map((task) => task.id) };
    });
  }

  private pendingMessages(taskId: string) {
    return (this.state.messages ?? []).filter((message) => message.toTaskId === taskId && message.deliveredTurn === undefined);
  }

  private activeSender(taskId: string, turn: number): CoordinationTask {
    this.assertOpen();
    const task = this.task(taskId);
    const active = this.active.get(taskId);
    if (!active || active.controller.signal.aborted || task.status !== "running" || task.cancelRequested || (task.turn ?? 0) !== turn) {
      throw new Error("Task capability is no longer active");
    }
    if (this.state.limits.maxDurationMs !== undefined && Date.now() >= this.state.startedAt! + this.state.limits.maxDurationMs) {
      throw new Error("Coordination deadline exceeded before task command");
    }
    return task;
  }

  private sendMessage(senderId: string, turn: number, commandId: string, spec: TaskMessageSpec): Promise<{ messageId: string }> {
    const input = freeze(copy(spec));
    return this.serial.run(async () => {
      const sender = this.activeSender(senderId, turn);
      name(commandId, "command id");
      validateMessage(input, this.state.limits.maxMessageBytes ?? 16_384);
      if (Object.keys(input).some((key) => !["toTaskId", "text"].includes(key))) throw new Error("Message accepts only toTaskId and text");
      const payload = canonical({ type: "send-message", senderId, turn, message: input });
      if (this.duplicate(commandId, payload)) return { messageId: commandId };
      if (sender.pendingHandoff) throw new Error("Task has a pending handoff");
      const recipient = this.task(input.toTaskId);
      if (senderId === recipient.id) throw new Error("Peer messages must target another task");
      if (recipient.cancelRequested || recipient.pendingHandoff || !["queued", "running", "waiting"].includes(recipient.status)) throw new Error("Message recipient is not accepting messages");
      if ((this.state.messages?.length ?? 0) >= (this.state.limits.maxMessages ?? 1024)) throw new Error("Coordination exceeds maxMessages");
      if (await this.policy.authorizeMessage?.(sender, recipient, input, this.state.id) !== true) throw new Error("Message authorization denied");
      this.activeSender(senderId, turn);
      await this.save({ ...this.state,
        messages: [...(this.state.messages ?? []), { ...input, id: commandId, fromTaskId: senderId, fromTurn: turn }],
        commands: { ...this.state.commands, [commandId]: payload },
      });
      await this.pump();
      return { messageId: commandId };
    });
  }

  private waitForMessages(taskId: string, turn: number, commandId: string): Promise<void> {
    return this.serial.run(async () => {
      const task = this.activeSender(taskId, turn);
      name(commandId, "command id");
      const payload = canonical({ type: "wait-messages", taskId, turn });
      if (this.duplicate(commandId, payload)) return;
      if (task.pendingHandoff) throw new Error("Task has a pending handoff");
      if (task.waitFor?.length) throw new Error("Cannot combine a message wait with a child wait in one turn");
      if (turn + 1 >= (this.state.limits.maxTaskTurns ?? 16)) throw new Error("No task turn remains to receive messages");
      await this.save({ ...this.replace({ ...task, waitForMessages: true }), commands: { ...this.state.commands, [commandId]: payload } });
    });
  }

  private handoff(taskId: string, turn: number, commandId: string, spec: HandoffSpec): Promise<{ taskId: string; agent: string }> {
    const input = freeze(copy(spec));
    return this.serial.run(async () => {
      const task = this.activeSender(taskId, turn);
      name(commandId, "command id"); validateHandoff(input, this.state.limits.maxHandoffBytes ?? 16_384);
      if (Object.keys(input).some((key) => !["agent", "input"].includes(key))) throw new Error("Handoff accepts only agent and input");
      const payload = canonical({ type: "handoff", taskId, turn, handoff: input });
      if (this.duplicate(commandId, payload)) return { taskId, agent: input.agent };
      if (task.pendingHandoff) throw new Error("Task has a pending handoff");
      if (task.waitFor?.length || task.waitForMessages || this.state.tasks.some((child) => child.parentTaskId === taskId && !["completed", "failed", "cancelled"].includes(child.status))) {
        throw new Error("Handoff cannot overlap a wait or unfinished children");
      }
      // Mail approved for the old controller must not silently cross an authority boundary.
      if (this.pendingMessages(taskId).length) throw new Error("Receive pending messages before handoff");
      if (input.agent === task.agent) throw new Error("Handoff must select a different agent");
      const targetAgent = this.agents.get(input.agent);
      if (!targetAgent) throw new Error(`Unknown agent: ${input.agent}`);
      if (handoffCount(task) >= (this.state.limits.maxHandoffs ?? 4)) throw new Error("Task exceeds maxHandoffs");
      if (turn + 1 >= (this.state.limits.maxTaskTurns ?? 16)) throw new Error("No task turn remains for handoff");
      const target = taskSpec(task, input.agent);
      if (await this.policy.authorizeHandoff?.(freeze(controller(task)), target, input.input, this.state.id) !== true ||
        await this.policy.authorize(target, this.state.id) !== true ||
        (task.parentTaskId !== undefined && await this.policy.authorizeDelegation?.(this.task(task.parentTaskId), target, this.state.id) !== true)) {
        throw new Error("Handoff authorization denied");
      }
      this.activeSender(taskId, turn);
      await this.save({ ...this.replace({ ...task, pendingHandoff: { ...input, commandId, agentVersion: targetAgent.version } }),
        commands: { ...this.state.commands, [commandId]: payload },
      });
      return { taskId, agent: input.agent };
    });
  }

  /** Called only after an adapter establishes the source's durable safe yield. */
  private transfer(task: CoordinationTask): CoordinationTask {
    const { pendingHandoff, inbox: _inbox, wakeFrom: _wake, output: _output, detail: _detail, ...rest } = task;
    const turn = (task.turn ?? 0) + 1;
    const to: TaskController = { agent: pendingHandoff!.agent, agentVersion: pendingHandoff!.agentVersion,
      sessionId: randomUUID(), dispatchId: randomUUID(), turn, sessionStartTurn: turn };
    return { ...rest, ...to, status: "queued", handoffs: [...(task.handoffs ?? []), {
      commandId: pendingHandoff!.commandId, input: pendingHandoff!.input, from: controller(task), to,
    }] };
  }

  private task(id: string): CoordinationTask {
    const task = this.state.tasks.find((task) => task.id === id);
    if (!task) throw new Error(`Unknown task: ${id}`);
    return task;
  }

  private replace(task: CoordinationTask): CoordinationSnapshot {
    return { ...this.state, tasks: this.state.tasks.map((current) => current.id === task.id ? task : current) };
  }

  private async save(state: CoordinationSnapshot): Promise<void> {
    if (this.fatal) throw this.fatal;
    const next = freeze(copy({ ...state, revision: this.state.revision + 1 }));
    try { await this.journal.commit(next, this.state.revision); }
    catch (error) { this.fail(error); throw error; }
    this.state = next;
    this.queue.push({ type: "state.changed", snapshot: this.snapshot() });
  }

  private fail(error: unknown): void {
    if (this.fatal) return;
    this.fatal = error instanceof Error ? error : new Error(String(error));
    if (this.deadline !== undefined) clearTimeout(this.deadline);
    for (const active of this.active.values()) active.controller.abort("Coordination persistence/control failure");
    this.queue.push({ type: "runtime.failed", message: this.fatal.message });
    for (const waiter of this.waiters) waiter.reject(this.fatal);
    this.waiters.clear();
  }

  private notifyIdle(): void {
    if (this.active.size !== 0) return;
    for (const waiter of this.waiters) this.fatal ? waiter.reject(this.fatal) : waiter.resolve(this.snapshot());
    this.waiters.clear();
    if (this.deadline !== undefined && this.state.tasks.every((task) => ["completed", "failed", "cancelled"].includes(task.status))) {
      clearTimeout(this.deadline); this.deadline = undefined;
    }
  }

  private assertOpen(): void {
    if (this.fatal) throw this.fatal;
    if (this.closing) throw new Error("Coordination runtime is closed");
  }

  private assertHostMutationAllowed(): void {
    this.assertOpen();
    if (this.state.stopReason) throw new Error("Stopped coordination cannot accept new work");
    if (this.state.startedAt !== undefined && this.state.limits.maxDurationMs !== undefined && Date.now() >= this.state.startedAt + this.state.limits.maxDurationMs) throw new Error("Coordination deadline exceeded");
  }
}

function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }

function controller(task: CoordinationTask): TaskController {
  return { agent: task.agent, agentVersion: task.agentVersion, sessionId: task.sessionId, dispatchId: task.dispatchId,
    turn: task.turn ?? 0, sessionStartTurn: task.sessionStartTurn ?? 0 };
}

function taskSpec(task: CoordinationTask, agent = task.agent): Readonly<TaskSpec> {
  return freeze({ id: task.id, agent, input: task.input, dependsOn: [...task.dependsOn] });
}

function captureOptions<T extends CoordinationRuntimeOptions>(options: T): T {
  name(options.id, "coordination id"); name(options.policy.version, "policy version");
  const agents = Object.fromEntries(Object.entries(options.agents).map(([key, agent]) => {
    name(key, "agent name"); name(agent.version, "agent version");
    return [key, Object.freeze({ version: agent.version, execute: agent.execute.bind(agent), recover: agent.recover.bind(agent),
      ...(agent.cancel === undefined ? {} : { cancel: agent.cancel.bind(agent) }),
      ...(agent.resolveApproval === undefined ? {} : { resolveApproval: agent.resolveApproval.bind(agent) }),
    })];
  }));
  return { ...options, agents, policy: { version: options.policy.version, authorize: options.policy.authorize.bind(options.policy),
    ...(options.policy.authorizeDelegation === undefined ? {} : { authorizeDelegation: options.policy.authorizeDelegation.bind(options.policy) }),
    ...(options.policy.authorizeMessage === undefined ? {} : { authorizeMessage: options.policy.authorizeMessage.bind(options.policy) }),
    ...(options.policy.authorizeHandoff === undefined ? {} : { authorizeHandoff: options.policy.authorizeHandoff.bind(options.policy) }),
    ...(options.policy.authorizeRetry === undefined ? {} : { authorizeRetry: options.policy.authorizeRetry.bind(options.policy) }),
    ...(options.policy.authorizeGraphRewrite === undefined ? {} : { authorizeGraphRewrite: options.policy.authorizeGraphRewrite.bind(options.policy) }),
  } };
}

function handoffCount(task: CoordinationTask): number {
  return (task.handoffs?.length ?? 0) + (task.attempts ?? []).reduce((sum, attempt) => sum + (attempt.task.handoffs?.length ?? 0), 0);
}

function latestHandoff(task: CoordinationTask) {
  return task.handoffs?.at(-1) ?? [...(task.attempts ?? [])].reverse().find((attempt) => attempt.task.handoffs?.length)?.task.handoffs?.at(-1);
}
