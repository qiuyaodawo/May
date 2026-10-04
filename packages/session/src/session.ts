import {
  AsyncEventQueue,
  isStreamingMayEvent,
  type AgentRuntime,
  type RuntimeDescriptor,
  DEFAULT_RUNTIME_DESCRIPTOR,
  assertRuntimeCompatible,
  validateRuntimeDescriptor,
  runtimeDescriptorsEqual,
  jsonEqual,
  type MayEvent,
  type Message,
  type ContinueOptions,
  type RunHandle,
  type RunOptions,
  type RunCheckpointEvent,
  toolCancellationMessage,
  type ToolCall,
  type UserMessage,
  userMessage,
} from "@may/core";

import type {
  RecordablePermissionEvent,
  SessionApprovalRequest,
  SessionContextCompaction,
  SessionEvent,
  SessionEventPayload,
  SessionToolPresentation,
  SessionRecovery,
  SessionForkOrigin,
} from "./events.js";
import { sessionToolResultContent } from "./events.js";
import { readSessionBranchPositions, type SessionBranchPosition } from "./branch.js";
import { SessionSteeringQueue, type SessionSteerOptions, type SessionSteeringInput } from "./steering.js";
import {
  SessionHistoryReader,
  type SessionHistoryQuery,
  type SessionHistoryPage,
} from "./history.js";
import {
  InMemorySessionStore,
  type SessionStore,
  validateSessionHistory,
} from "./store.js";

export interface SessionOptions {
  runtime: AgentRuntime;
  store?: SessionStore;
  id?: string;
  metadata?: Record<string, unknown>;
  deferBranchPositions?: boolean;
}

export interface ResumeSessionOptions {
  id: string;
  store: SessionStore;
  deferBranchPositions?: boolean;
  createRuntime(
    messages: Message[],
    info: SessionRuntimeInfo,
  ): AgentRuntime | Promise<AgentRuntime>;
}

export interface SessionForkOptions extends Omit<ResumeSessionOptions, "id"> {
  readonly sourceId: string;
  readonly positionSeq: number;
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly stateKeys?: readonly string[];
  readonly transformState?: (key: string, value: unknown) => unknown;
  readonly deferForkReady?: boolean;
}

export interface SessionModelMeasurement {
  readonly inputTokens: number;
  readonly contextMessageCount: number;
}

export interface SessionRuntimeInfo {
  readonly state?: Readonly<Record<string, unknown>>;
  readonly latestModelMeasurement?: SessionModelMeasurement;
  readonly runtime?: RuntimeDescriptor;
  readonly runtimeState?: unknown;
}

interface SuspendedRuntime {
  readonly descriptor: RuntimeDescriptor;
  readonly state: unknown;
  readonly closing: Promise<void>;
}

/** Optional host delivery identity. Duplicates are rejected, not submitted again. */
export interface SessionSubmitOptions extends Omit<RunOptions, "stepInputSource"> {
  readonly stepInputSource?: never;
  readonly inputId?: string;
}

/** Session 的补充输入统一通过 steer() 保存和交付。 */
export interface SessionContinueOptions extends Omit<ContinueOptions, "stepInputSource"> {
  readonly stepInputSource?: never;
}

export class Session {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly forkOrigin: SessionForkOrigin | undefined;

  private runtime: AgentRuntime;
  private readonly store: SessionStore;
  private readonly historyReader: SessionHistoryReader;
  private seq: number;
  private tail: Promise<void> = Promise.resolve();
  private recordTail: Promise<void> = Promise.resolve();
  private readonly completedModelSteps = new Set<string>();
  private readonly modelCompletionWaiters = new Map<string, Deferred<void>>();
  private readonly observedStepStarts = new Set<string>();
  private readonly stepStartWaiters = new Map<string, Deferred<void>>();
  private readonly activeRunObservations = new Set<string>();
  private readonly finishedRunObservationErrors = new Map<string, unknown>();
  private readonly approvalRecords = new Map<string, Promise<void>>();
  private readonly checkpointed = new Set<string>();
  private readonly recoveries = new Map<string, SessionRecovery>();
  private persistenceFailed = false;
  private runtimeClosed = false;
  private runtimeClosing: Promise<void> | undefined;
  private runtimeMutation = false;
  private pendingStarts = 0;
  private settlingRuns = 0;
  private suspendedRuntime: SuspendedRuntime | undefined;
  private readonly steering: SessionSteeringQueue;
  private activeRun: RunHandle | undefined;
  private readonly submittedInputIds = new Set<string>();
  private readonly deferBranchPositions: boolean;

  private constructor(
    id: string,
    runtime: AgentRuntime,
    store: SessionStore,
    metadata: Record<string, unknown> | undefined,
    seq: number,
    history: readonly SessionEvent[] = [],
    deferBranchPositions = false,
  ) {
    this.id = id;
    this.runtime = runtime;
    this.store = store;
    this.historyReader = new SessionHistoryReader(store);
    this.metadata = metadata === undefined ? undefined : { ...metadata };
    const created = history[0];
    this.forkOrigin = created?.type === "session.created" && created.fork !== undefined ? structuredClone(created.fork) : undefined;
    this.seq = seq;
    this.deferBranchPositions = deferBranchPositions;
    this.steering = new SessionSteeringQueue((event) => this.record(event), history);
    for (const event of history) {
      if (event.type === "input.submitted" && event.inputId !== undefined) this.submittedInputIds.add(event.inputId);
    }
  }

  static async create(options: SessionOptions): Promise<Session> {
    const id = options.id ?? createSessionId();
    const store = options.store ?? new InMemorySessionStore();
    const existing = await store.read(id);

    if (existing.length > 0) {
      throw new Error(`Session "${id}" already exists`);
    }

    const session = new Session(
      id,
      options.runtime,
      store,
      options.metadata,
      0,
      [],
      options.deferBranchPositions,
    );
    const runtime = options.runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
    validateRuntimeDescriptor(runtime);
    const initialState = options.runtime.saveState === undefined ? undefined : await snapshotRuntimeState(options.runtime);
    const created: SessionEventPayload = {
      type: "session.created", runtime: { ...runtime },
      ...(session.metadata === undefined ? {} : { metadata: { ...session.metadata } }),
    };
    await session.record(created);
    if (initialState !== undefined) {
      await session.record({ type: "runtime.state.saved", runtime: { ...runtime }, state: initialState });
    }
    return session;
  }

  static async resume(options: ResumeSessionOptions): Promise<Session> {
    const events = await new SessionHistoryReader(options.store).readAll(
      options.id,
    );
    if (events.length === 0) {
      throw new Error(`Session "${options.id}" does not exist`);
    }

    validateSessionHistory(options.id, events);
    const created = events[0]!;
    if (created.type !== "session.created") {
      throw new Error(`Session "${options.id}" has no creation event`);
    }
    if (events.slice(1).some((event) => event.type === "session.created")) {
      throw new Error(`Session "${options.id}" has multiple creation events`);
    }
    if (created.fork !== undefined && !events.some((event) => event.type === "session.fork.ready")) {
      throw new Error(`Session "${options.id}" has an incomplete fork; inspect its history before reopening`);
    }

    const recoveredEvents = [...events];
    const repairs: SessionEvent[] = [];
    for (const payload of interruptedRuns(events)) {
      const event = { ...payload, sessionId: options.id, seq: recoveredEvents.length + 1, timestamp: Date.now() };
      recoveredEvents.push(event);
      repairs.push(event);
    }
    const replay = replaySession(recoveredEvents);
    const runtime = await options.createRuntime(replay.messages, replay.info);
    try {
      const savedDescriptor = replay.info.runtime ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const currentDescriptor = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const migrated = !runtimeDescriptorsEqual(savedDescriptor, currentDescriptor);
      let runtimeState = replay.info.runtimeState;
      if (migrated) {
        if (runtime.migrateState === undefined) assertRuntimeCompatible(savedDescriptor, runtime);
        runtimeState = await runtime.migrateState!(savedDescriptor, runtimeState);
      }
      if (runtimeState !== undefined) {
        if (runtime.restoreState === undefined) throw new Error("Runtime cannot restore its saved Session state");
        await runtime.restoreState(runtimeState);
      }
      if (runtime.saveState !== undefined) runtimeState = await snapshotRuntimeState(runtime);
      for (const event of repairs) await options.store.append(event);
      if (migrated || !jsonEqual(runtimeState, replay.info.runtimeState)) {
        const change: SessionEvent = {
          ...(migrated
            ? { type: "runtime.changed", ...(runtimeState === undefined ? {} : { state: structuredClone(runtimeState) }) }
            : { type: "runtime.state.saved", state: structuredClone(runtimeState) }),
          runtime: { ...currentDescriptor },
          sessionId: options.id, seq: recoveredEvents.length + 1, timestamp: Date.now(),
        };
        await options.store.append(change);
        recoveredEvents.push(change);
      }
      const session = new Session(
        options.id,
        runtime,
        options.store,
        created.metadata,
        recoveredEvents.length,
        recoveredEvents,
        options.deferBranchPositions,
      );
      for (const event of recoveredEvents) {
        if (event.type === "run.interrupted") {
          for (const recovery of event.recoveries) {
            if (recovery.status === "unknown") session.recoveries.set(recovery.id, recovery);
          }
        } else if (event.type === "recovery.resolved") session.recoveries.delete(event.recoveryId);
      }
      for (const runId of new Set(session.steering.list().filter((input) => input.status === "pending").map((input) => input.runId!))) {
        const terminal = [...recoveredEvents].reverse().find((event) => "runId" in event && event.runId === runId && ["run.completed", "run.yielded", "run.cancelled", "run.failed", "run.interrupted"].includes(event.type));
        await session.steering.finish(runId, terminal?.type === "run.completed" || terminal?.type === "run.yielded" ? "idle" : "cancelled", terminal?.type ?? "interrupted");
      }
      return session;
    } catch (error) {
      return closeRejectedRuntime(runtime, error);
    }
  }

  static async fork(options: SessionForkOptions): Promise<Session> {
    if (options.store.inspect === undefined) throw new Error("Session forking requires read-only store inspection");
    const source = await options.store.inspect(options.sourceId);
    validateSessionHistory(options.sourceId, source);
    const selected = readSessionBranchPositions(source).find((position) => position.positionSeq === options.positionSeq);
    if (selected === undefined || !selected.available) throw new Error(selected?.reason ?? "Selected history position has no recoverable state");
    const id = options.id ?? createSessionId();
    if (id === options.sourceId || (await options.store.read(id)).length > 0) throw new Error(`Session "${id}" already exists`);
    const stateKeys = new Set(options.stateKeys ?? []);
    const queued = new Map<string, UserMessage>();
    const history: SessionEvent[] = [];
    const append = (event: SessionEventPayload, timestamp: number) => history.push({ ...structuredClone(event), sessionId: id, seq: history.length + 1, timestamp });
    const created = source[0];
    if (created?.type !== "session.created") throw new Error("Source Session has no creation event");
    append({ type: "session.created", ...(created.runtime === undefined ? {} : { runtime: created.runtime }),
      ...((options.metadata ?? created.metadata) === undefined ? {} : { metadata: { ...(options.metadata ?? created.metadata) } }),
      fork: { sessionId: options.sourceId, positionSeq: options.positionSeq, runId: selected.runId } }, Date.now());
    for (const event of source.slice(1, options.positionSeq)) {
      if (event.type.startsWith("approval.") || event.type.startsWith("rule.")) { append({ type: "history.omitted", reason: "permission" }, event.timestamp); continue; }
      if (event.type === "session.fork.ready") { append({ type: "history.omitted", reason: "fork-initialization" }, event.timestamp); continue; }
      if (event.type === "state.updated") {
        if (stateKeys.has(event.key)) append({ type: "state.updated", key: event.key,
          value: options.transformState === undefined ? event.value : options.transformState(event.key, structuredClone(event.value)) }, event.timestamp);
        else append({ type: "history.omitted", reason: "application-state" }, event.timestamp);
        continue;
      }
      if (event.type === "input.steering.queued") { queued.set(event.input.inputId, event.input.message); append({ type: "history.omitted", reason: "unconsumed-input" }, event.timestamp); continue; }
      if (event.type === "input.steering.finished") { append({ type: "history.omitted", reason: "unconsumed-input" }, event.timestamp); continue; }
      if (event.type === "input.steering.delivered") {
        const messages = event.inputIds.map((inputId) => {
          const message = queued.get(inputId);
          if (message === undefined) throw new Error(`Delivered input has no saved content: ${inputId}`);
          return message;
        });
        append({ type: "input.generated", runId: event.runId, step: event.step, messages, reason: "Inherited delivered input" }, event.timestamp);
        continue;
      }
      if (event.type === "input.submitted") { append({ type: "input.submitted", message: event.message }, event.timestamp); continue; }
      append(event, event.timestamp);
    }
    const replay = replaySession(history);
    const runtime = await options.createRuntime(replay.messages, replay.info);
    try {
      const savedDescriptor = replay.info.runtime ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const currentDescriptor = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      let state = replay.info.runtimeState;
      const migrated = !runtimeDescriptorsEqual(savedDescriptor, currentDescriptor);
      if (migrated) {
        if (runtime.migrateState === undefined) assertRuntimeCompatible(savedDescriptor, runtime);
        state = await runtime.migrateState!(savedDescriptor, state);
      }
      if (state !== undefined) {
        if (runtime.restoreState === undefined) throw new Error("Runtime cannot restore the selected Session state");
        await runtime.restoreState(state);
      }
      if (runtime.saveState !== undefined) state = await snapshotRuntimeState(runtime);
      if (migrated || state !== undefined) append({ type: migrated ? "runtime.changed" : "runtime.state.saved",
        runtime: { ...currentDescriptor }, ...(state === undefined ? {} : { state }) } as SessionEventPayload, Date.now());
      for (const event of history) await options.store.append(event);
      if (options.deferForkReady !== true) {
        const ready: SessionEvent = { type: "session.fork.ready", sessionId: id, seq: history.length + 1, timestamp: Date.now() };
        await options.store.append(ready);
        history.push(ready);
      }
      return new Session(id, runtime, options.store, options.metadata ?? created.metadata, history.length, history, options.deferBranchPositions);
    } catch (error) { return closeRejectedRuntime(runtime, error); }
  }

  async branchPositions(): Promise<readonly SessionBranchPosition[]> {
    return readSessionBranchPositions(await this.history());
  }

  async saveForkReady(): Promise<void> {
    if (this.forkOrigin === undefined) throw new Error("Only a forked Session can save initialization readiness");
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    this.assertIdleRuntime();
    if (this.persistenceFailed) throw new Error("Session persistence failed before branch initialization completed");
    if ((await this.history()).some(event => event.type === "session.fork.ready")) return;
    await this.record({ type: "session.fork.ready" });
  }

  async saveBranchPosition(runId: string, options: import("./branch.js").SessionBranchCompletionOptions = {}): Promise<void> {
    if (this.persistenceFailed) throw new Error("Session persistence failed; reopen the Session before branching");
    if (this.activeRun !== undefined || this.activeRunObservations.size > 0 || this.settlingRuns > 0 || this.runtimeMutation) {
      throw new Error("Branch positions require completed tool execution and saved Runtime state");
    }
    const history = await this.history();
    const latestStarted = [...history].reverse().find((event) => event.type === "run.started");
    if (latestStarted?.type !== "run.started" || latestStarted.runId !== runId) throw new Error("Only the latest completed Run can save a branch position");
    if (history.some((event) => event.type === "run.settled" && event.runId === runId)) return;
    const completed = history.some((event) => event.type === "run.completed" && event.runId === runId);
    const hostCompleted = options.allowYielded === true && history.some((event) => event.type === "run.yielded" && event.runId === runId);
    if (!completed && !hostCompleted) return;
    await this.record({ type: "run.settled", runId, ...(hostCompleted ? { hostCompleted: true as const } : {}) });
  }

  submit(options: SessionSubmitOptions): Promise<RunHandle> {
    assertSessionInputOptions(options);
    return this.enqueueRun(() => this.start(options));
  }

  async steer(options: SessionSteerOptions): Promise<SessionSteeringInput> {
    this.assertRecovered();
    if (options.inputId !== undefined && this.submittedInputIds.has(options.inputId)) throw new Error(`Input already submitted: ${options.inputId}`);
    return this.steering.enqueue(options, this.activeRun?.id);
  }

  listSteeringInputs(): readonly SessionSteeringInput[] {
    return this.steering.list();
  }

  cancelSteeringInputs(reason = "Cancelled by user"): Promise<void> {
    return this.steering.cancel(reason);
  }

  startSteeringInput(inputId: string, options: Omit<SessionSubmitOptions, "input" | "inputId"> = {}): Promise<RunHandle> {
    assertSessionInputOptions(options);
    const input = this.steering.idle(inputId);
    return this.submit({ ...options, input: input.message, inputId });
  }

  /** Continue the current context without recording a new user input. */
  continue(options: SessionContinueOptions = {}): Promise<RunHandle> {
    assertSessionInputOptions(options);
    return this.enqueueRun(() => this.startContinuation(options));
  }

  private enqueueRun(operation: () => RunHandle | Promise<RunHandle>): Promise<RunHandle> {
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (this.suspendedRuntime !== undefined) throw new Error("Session runtime is suspended");
    if (this.runtimeMutation) throw new Error("Session runtime is changing");
    this.pendingStarts += 1;
    const started = this.tail.then(operation).then((run) => {
      this.pendingStarts -= 1;
      return run;
    }, (error: unknown) => {
      this.pendingStarts -= 1;
      throw error;
    });
    return this.queue(started);
  }

  private queue(started: Promise<RunHandle>): Promise<RunHandle> {
    this.tail = started
      .then((run) => run.result)
      .then(
        () => undefined,
        () => undefined,
      );
    return started;
  }

  async history(): Promise<readonly SessionEvent[]> {
    await this.recordTail;
    return this.historyReader.readAll(this.id);
  }

  async getRuntimeInfo(): Promise<{ readonly messages: Message[]; readonly info: SessionRuntimeInfo }> {
    this.assertIdleRuntime();
    this.runtimeMutation = true;
    try { return replaySession(await this.history()); }
    finally { this.runtimeMutation = false; }
  }

  async suspendRuntime(): Promise<void> {
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (this.suspendedRuntime !== undefined) return this.suspendedRuntime.closing;
    this.assertIdleRuntime();
    this.assertRecovered();
    this.runtimeMutation = true;
    try {
      const descriptor = structuredClone(this.runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR);
      validateRuntimeDescriptor(descriptor);
      const state = this.runtime.saveState === undefined
        ? replaySession(await this.history()).info.runtimeState
        : await snapshotRuntimeState(this.runtime);
      if (state !== undefined) {
        if (descriptor.stateVersion === undefined) throw new Error("Stateful runtime requires a versioned descriptor");
        await this.record({ type: "runtime.state.saved", runtime: descriptor, state: structuredClone(state) });
      }
      const closing = Promise.resolve().then(() => this.runtime.close?.());
      this.suspendedRuntime = { descriptor, state: structuredClone(state), closing };
      await closing;
    } finally {
      this.runtimeMutation = false;
    }
  }

  async replaceRuntime(runtime: AgentRuntime): Promise<void> {
    const previous = this.runtime;
    let accepted = false;
    let changing = false;
    try {
      this.assertIdleRuntime();
      this.assertRecovered(true);
      this.runtimeMutation = true;
      changing = true;
      const suspended = this.suspendedRuntime;
      if (suspended !== undefined) await suspended.closing;
      if (suspended !== undefined && runtime === previous) throw new Error("A suspended runtime requires a new replacement instance");
      const savedDescriptor = suspended?.descriptor ?? this.runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const currentDescriptor = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const migrated = !runtimeDescriptorsEqual(savedDescriptor, currentDescriptor);
      let state = suspended === undefined
        ? this.runtime.saveState === undefined
          ? replaySession(await this.history()).info.runtimeState
          : await snapshotRuntimeState(this.runtime)
        : structuredClone(suspended.state);
      if (migrated) {
        if (runtime.migrateState === undefined) assertRuntimeCompatible(savedDescriptor, runtime);
        state = await runtime.migrateState!(savedDescriptor, state);
      }
      if (state !== undefined) {
        if (runtime.restoreState === undefined) throw new Error("Replacement runtime cannot restore Session state");
        await runtime.restoreState(state);
      }
      if (runtime.saveState !== undefined) state = await snapshotRuntimeState(runtime);
      if (migrated) {
        await this.record({ type: "runtime.changed", runtime: { ...currentDescriptor }, ...(state === undefined ? {} : { state: structuredClone(state) }) });
      } else if (state !== undefined) {
        if (currentDescriptor.stateVersion === undefined) throw new Error("Stateful runtime requires a versioned descriptor");
        await this.record({ type: "runtime.state.saved", runtime: { ...currentDescriptor }, state: structuredClone(state) });
      }
      this.runtime = runtime;
      this.suspendedRuntime = undefined;
      accepted = true;
      if (suspended === undefined && previous !== runtime) await previous.close?.();
    } catch (error) {
      if (!accepted && previous !== runtime) return closeRejectedRuntime(runtime, error);
      throw error;
    } finally {
      if (changing) this.runtimeMutation = false;
    }
  }

  async closeRuntime(): Promise<void> {
    if (this.runtimeClosing !== undefined) return this.runtimeClosing;
    if (this.activeRun !== undefined || this.activeRunObservations.size > 0 || this.settlingRuns > 0 || this.runtimeMutation) {
      throw new Error("Cannot close a runtime during execution or state changes");
    }
    this.runtimeClosed = true;
    this.runtimeClosing = this.suspendedRuntime?.closing
      ?? Promise.resolve().then(() => this.runtime.close?.());
    return this.runtimeClosing;
  }

  async saveRuntimeState(): Promise<void> {
    this.assertIdleRuntime();
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (this.suspendedRuntime !== undefined) return this.suspendedRuntime.closing;
    this.runtimeMutation = true;
    try { await this.persistRuntimeState(); }
    finally { this.runtimeMutation = false; }
  }

  private assertIdleRuntime(): void {
    if (this.activeRun !== undefined || this.pendingStarts > 0 || this.activeRunObservations.size > 0 || this.settlingRuns > 0 || this.runtimeMutation) {
      throw new Error("Session runtime requires an idle boundary with no queued Runs");
    }
  }

  private async persistRuntimeState(): Promise<void> {
    if (this.runtime.saveState === undefined) return;
    const state = await snapshotRuntimeState(this.runtime);
    await this.record({ type: "runtime.state.saved", runtime: { ...this.runtime.descriptor! }, state: structuredClone(state) });
  }

  async queryHistory(
    query: SessionHistoryQuery = {},
  ): Promise<SessionHistoryPage> {
    await this.recordTail;
    return this.historyReader.query(this.id, query);
  }

  recordPermissionEvent(event: RecordablePermissionEvent): Promise<void> {
    if (event.type === "rule.created" || event.type === "rule.revoked" || event.type === "rule.used") {
      return this.record(toPermissionSessionEvent(event), event.timestamp);
    }
    if (event.type === "approval.requested") {
      const operation = this.waitForModelCompletion(
        event.request.context.runId,
        event.request.context.step,
      ).then(() =>
        this.record(toPermissionSessionEvent(event), event.timestamp)
      );
      this.approvalRecords.set(event.request.id, operation);
      return operation;
    }

    const previous = this.approvalRecords.get(event.requestId) ??
      Promise.resolve();
    const operation = previous.then(() =>
      this.record(toPermissionSessionEvent(event), event.timestamp)
    );
    this.approvalRecords.set(event.requestId, operation);
    void operation.finally(() => {
      if (this.approvalRecords.get(event.requestId) === operation) {
        this.approvalRecords.delete(event.requestId);
      }
    }).catch(() => undefined);
    return operation;
  }

  async recordContextCompaction(
    compaction: SessionContextCompaction,
    afterRunStep?: { readonly runId: string; readonly step: number },
  ): Promise<void> {
    if (afterRunStep !== undefined) {
      await this.waitForStepStart(afterRunStep.runId, afterRunStep.step);
    }
    await this.record({
      type: "context.compacted",
      strategy: compaction.strategy,
      messages: [...compaction.messages],
      beforeMessageCount: compaction.beforeMessageCount,
      afterMessageCount: compaction.afterMessageCount,
      beforeEstimatedTokens: compaction.beforeEstimatedTokens,
      afterEstimatedTokens: compaction.afterEstimatedTokens,
    });
  }

  async recordToolPresentation(
    presentation: SessionToolPresentation,
  ): Promise<void> {
    validateToolPresentation(presentation);
    const snapshot = JSON.parse(JSON.stringify(presentation)) as SessionToolPresentation;
    await this.record({ type: "tool.presentation", ...snapshot });
  }

  private async start(options: SessionSubmitOptions): Promise<RunHandle> {
    this.assertRecovered();
    if (options.inputId !== undefined) {
      if (typeof options.inputId !== "string" || options.inputId.length === 0 || options.inputId.length > 256) throw new TypeError("inputId must be a non-empty string of at most 256 characters");
      if ((await this.history()).some((event) => event.type === "input.submitted" && event.inputId === options.inputId)) throw new Error(`Input already submitted: ${options.inputId}`);
      const steeringInput = this.steering.get(options.inputId);
      if (steeringInput !== undefined) {
        this.steering.idle(options.inputId);
        const message = typeof options.input === "string" ? userMessage(options.input) : options.input;
        if (JSON.stringify(message) !== JSON.stringify(steeringInput.message)) throw new Error("Steering input content cannot change when starting execution");
      }
    }
    const runtimeOptions: RunOptions = {
      ...options,
      checkpoint: (event) => this.checkpoint(event, options.checkpoint),
      stepInputSource: ({ runId, step, signal }) => this.steering.deliver(runId, step, signal),
      traceAttributes: {
        ...(options.traceAttributes ?? {}),
        "may.session.id": this.id,
      },
    };
    const input: UserMessage = typeof options.input === "string"
      ? userMessage(options.input)
      : options.input;
    if (options.signal?.aborted === true) {
      return this.wrapRun(this.runtime.run(runtimeOptions));
    }
    if (options.inputId !== undefined) this.submittedInputIds.add(options.inputId);
    await this.record({ type: "input.submitted", message: input, ...(options.inputId === undefined ? {} : { inputId: options.inputId }) });
    if (options.inputId !== undefined) {
      this.steering.submitted(options.inputId);
    }

    this.assertRecovered();
    return this.wrapRun(this.runAfterInputCommit(runtimeOptions));
  }

  private runAfterInputCommit(options: RunOptions): RunHandle {
    const externalSignal = options.signal;
    if (externalSignal === undefined) return this.runtime.run(options);

    // Once input.submitted is durable, let Core start its non-cancellable
    // context append before forwarding an abort that arrived during storage.
    // This keeps the live context and replay on the same side of the commit.
    const controller = new AbortController();
    const run = this.runtime.run({ ...options, signal: controller.signal });
    const forwardAbort = () => controller.abort(externalSignal.reason);
    if (externalSignal.aborted) {
      forwardAbort();
    } else {
      externalSignal.addEventListener("abort", forwardAbort, { once: true });
      const removeListener = () =>
        externalSignal.removeEventListener("abort", forwardAbort);
      void run.result.then(removeListener, removeListener);
    }
    return run;
  }

  private startContinuation(options: SessionContinueOptions): RunHandle {
    this.assertRecovered();
    return this.wrapRun(this.runtime.continue({
      ...options,
      checkpoint: (event) => this.checkpoint(event, options.checkpoint),
      stepInputSource: ({ runId, step, signal }) => this.steering.deliver(runId, step, signal),
      traceAttributes: {
        ...(options.traceAttributes ?? {}),
        "may.session.id": this.id,
      },
    }));
  }

  private wrapRun(run: RunHandle): RunHandle {
    this.activeRun = run;
    const completion = run.result.then(async (value) => {
      this.settlingRuns += 1;
      try {
        if (this.activeRun === run) this.activeRun = undefined;
        await this.persistRuntimeState();
        await this.steering.finish(run.id, "idle", value.finishReason === "yielded" ? "yielded" : "completed");
        return value;
      } finally {
        this.settlingRuns -= 1;
      }
    }, async (error: unknown) => {
      this.settlingRuns += 1;
      try {
        if (this.activeRun === run) this.activeRun = undefined;
        await this.persistRuntimeState();
        await this.steering.finish(run.id, "cancelled", error instanceof Error ? error.message : "Run failed");
        throw error;
      } finally {
        this.settlingRuns -= 1;
      }
    });
    void completion.catch(() => undefined);
    const events = new AsyncEventQueue<MayEvent>({
      maxBufferedValues: 1024,
      isDroppable: isStreamingMayEvent,
    });
    this.finishedRunObservationErrors.clear();
    this.activeRunObservations.add(run.id);
    const observation = this.observeRun(run, events);
    const result = (async () => {
      try {
        await observation;
      } catch (error) {
        run.cancel("Session event persistence failed");
        throw error;
      }
      const value = await completion;
      if (!this.deferBranchPositions) await this.saveBranchPosition(run.id);
      return value;
    })();

    void result.catch(() => undefined);

    return {
      id: run.id,
      events,
      result,
      ...(run.traceContext === undefined
        ? {}
        : { traceContext: run.traceContext }),
      cancel: (reason?: string) => run.cancel(reason),
    };
  }

  private async observeRun(
    run: RunHandle,
    events: AsyncEventQueue<MayEvent>,
  ): Promise<void> {
    let observationError: unknown;
    try {
      for await (const event of run.events) {
        if (event.type === "run.failed" && event.error.code === "RUN_CHECKPOINT_FAILED") this.persistenceFailed = true;
        const payload = toSessionEvent(event);
        if (payload !== undefined && !this.checkpointed.delete(checkpointKey(event))) {
          await this.record(payload, event.timestamp);
        }
        if (event.type === "model.completed") {
          this.markModelCompleted(event.runId, event.step);
        }
        if (event.type === "step.started") {
          this.markStepStarted(event.runId, event.step);
        }
        events.push(event);
      }
    } catch (error) {
      observationError = error;
      throw error;
    } finally {
      const terminalError = observationError ?? new Error(
        `Run "${run.id}" ended before the requested event was observed`,
      );
      this.activeRunObservations.delete(run.id);
      this.finishedRunObservationErrors.set(run.id, terminalError);
      this.rejectModelCompletionWaiters(run.id, terminalError);
      this.clearModelCompletionState(run.id);
      for (const key of this.checkpointed) if ((JSON.parse(key) as unknown[])[1] === run.id) this.checkpointed.delete(key);
      events.close();
    }
  }

  private waitForModelCompletion(runId: string, step: number): Promise<void> {
    const key = modelStepKey(runId, step);
    if (this.completedModelSteps.has(key)) return Promise.resolve();
    const finishedError = this.finishedRunObservationErrors.get(runId);
    if (finishedError !== undefined) return Promise.reject(finishedError);
    if (!this.activeRunObservations.has(runId)) {
      return Promise.reject(new Error(`Run "${runId}" is not active`));
    }

    let waiter = this.modelCompletionWaiters.get(key);
    if (waiter === undefined) {
      waiter = createDeferred<void>();
      this.modelCompletionWaiters.set(key, waiter);
    }
    return waiter.promise;
  }

  private waitForStepStart(runId: string, step: number): Promise<void> {
    const key = modelStepKey(runId, step);
    if (this.observedStepStarts.has(key)) return Promise.resolve();
    const finishedError = this.finishedRunObservationErrors.get(runId);
    if (finishedError !== undefined) return Promise.reject(finishedError);
    if (!this.activeRunObservations.has(runId)) {
      return Promise.reject(new Error(`Run "${runId}" is not active`));
    }

    let waiter = this.stepStartWaiters.get(key);
    if (waiter === undefined) {
      waiter = createDeferred<void>();
      this.stepStartWaiters.set(key, waiter);
    }
    return waiter.promise;
  }

  private markStepStarted(runId: string, step: number): void {
    const key = modelStepKey(runId, step);
    this.observedStepStarts.add(key);
    const waiter = this.stepStartWaiters.get(key);
    if (waiter !== undefined) {
      this.stepStartWaiters.delete(key);
      waiter.resolve();
    }
  }

  private markModelCompleted(runId: string, step: number): void {
    const key = modelStepKey(runId, step);
    this.completedModelSteps.add(key);
    const waiter = this.modelCompletionWaiters.get(key);
    if (waiter !== undefined) {
      this.modelCompletionWaiters.delete(key);
      waiter.resolve();
    }
  }

  private rejectModelCompletionWaiters(runId: string, error: unknown): void {
    const prefix = `${runId}:`;
    for (const [key, waiter] of this.modelCompletionWaiters) {
      if (!key.startsWith(prefix)) continue;
      this.modelCompletionWaiters.delete(key);
      waiter.reject(error);
    }
    for (const [key, waiter] of this.stepStartWaiters) {
      if (!key.startsWith(prefix)) continue;
      this.stepStartWaiters.delete(key);
      waiter.reject(error);
    }
  }

  private clearModelCompletionState(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.completedModelSteps) {
      if (key.startsWith(prefix)) this.completedModelSteps.delete(key);
    }
    for (const key of this.observedStepStarts) {
      if (key.startsWith(prefix)) this.observedStepStarts.delete(key);
    }
  }

  private record(
    payload: SessionEventPayload,
    timestamp = Date.now(),
  ): Promise<void> {
    const operation = this.recordTail.then(() =>
      this.recordNow(payload, timestamp)
    );
    this.recordTail = operation.catch(() => undefined);
    return operation;
  }

  private async recordNow(
    payload: SessionEventPayload,
    timestamp: number,
  ): Promise<void> {
    const seq = this.seq + 1;
    const event: SessionEvent = {
      ...payload,
      sessionId: this.id,
      seq,
      timestamp,
    };
    try { await this.store.append(event); }
    catch (error) { this.persistenceFailed = true; throw error; }
    this.seq = seq;
  }

  listRecoveries(): readonly SessionRecovery[] {
    return [...this.recoveries.values()].map((value) => structuredClone(value));
  }

  /** Persist bounded, application-owned state independently of compactable messages. */
  async recordState(key: string, value: unknown): Promise<void> {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(key)) throw new Error("Invalid session state key");
    const snapshot: unknown = JSON.parse(JSON.stringify(value));
    if (JSON.stringify(snapshot).length > 1_048_576) throw new Error("Session state exceeds 1 MiB");
    await this.record({ type: "state.updated", key, value: snapshot });
  }

  /** The host must verify external effects and describe the finding before continuing. */
  resolveRecovery(id: string, finding: string): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.persistenceFailed) throw new Error("Session persistence failed; reopen the session before recovery");
      const recovery = this.recoveries.get(id);
      if (recovery === undefined) throw new Error(`Unknown recovery: ${id}`);
      if (finding.trim() === "" || finding.length > 32768) throw new Error("Recovery finding must contain 1-32768 characters");
      const message = userMessage(`Verified recovery of tool call ${id} (${recovery.call.name}):\n${finding}`);
      await this.record({ type: "recovery.resolved", recoveryId: id, message });
      try { await this.runtime.appendMessages([message]); }
      catch (error) { this.persistenceFailed = true; throw error; }
      this.recoveries.delete(id);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private assertRecovered(allowSuspended = false): void {
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (!allowSuspended && this.suspendedRuntime !== undefined) throw new Error("Session runtime is suspended");
    if (this.persistenceFailed) throw new Error("Session persistence failed; reopen the session before continuing");
    if (this.recoveries.size > 0) throw new SessionRecoveryRequiredError(this.listRecoveries());
  }

  private async checkpoint(event: RunCheckpointEvent, extra?: (event: RunCheckpointEvent) => Promise<void>): Promise<void> {
    const live = { ...event, timestamp: Date.now(), seq: 0 };
    const payload = event.type === "run.started"
      ? { ...event, checkpointVersion: 1 as const }
      : toSessionEvent(live);
    if (payload !== undefined) {
      await this.record(payload, live.timestamp);
      this.checkpointed.add(checkpointKey(event));
    }
    await extra?.(event);
  }
}

export class SessionRecoveryRequiredError extends Error {
  readonly code = "SESSION_RECOVERY_REQUIRED";
  constructor(readonly recoveries: readonly SessionRecovery[]) {
    super("Interrupted tools have unknown outcomes. Inspect /recovery and record verified findings before continuing.");
    this.name = "SessionRecoveryRequiredError";
  }
}

function checkpointKey(event: { type: string; runId: string; step?: number; call?: ToolCall }): string {
  return JSON.stringify([event.type, event.runId, event.step, event.call?.id]);
}

function interruptedRuns(events: readonly SessionEvent[]): SessionEventPayload[] {
  const runs = new Map<string, { version?: 1; pending: Map<string, SessionRecovery>; started: Set<string> }>();
  const approvals = new Set<string>();
  for (const event of events) {
    if (event.type === "approval.requested") approvals.add(event.request.id);
    if (event.type === "approval.resolved" || event.type === "approval.cancelled") approvals.delete(event.requestId);
    if (event.type === "run.started") {
      runs.set(event.runId, { ...(event.checkpointVersion === undefined ? {} : { version: event.checkpointVersion }), pending: new Map(), started: new Set() });
    } else if (event.type === "assistant.completed") {
      const run = runs.get(event.runId);
      for (const call of event.message.toolCalls ?? []) {
        const id = `${event.runId}:${event.step}:${call.id}`;
        run?.pending.set(id, { id, runId: event.runId, step: event.step, call, status: "unknown" });
      }
    } else if (event.type === "tool.started") {
      runs.get(event.runId)?.started.add(`${event.runId}:${event.step}:${event.call.id}`);
    } else if (event.type === "tool.completed" || event.type === "tool.failed") {
      runs.get(event.runId)?.pending.delete(`${event.runId}:${event.step}:${event.call.id}`);
    } else if (event.type === "run.completed" || event.type === "run.yielded" || event.type === "run.cancelled" || event.type === "run.interrupted") {
      runs.delete(event.runId);
    } else if (event.type === "run.failed") {
      // A failure can leave unclosed calls (e.g. a failed persistence barrier).
      if (runs.get(event.runId)?.pending.size === 0) runs.delete(event.runId);
    }
  }
  const repairs: SessionEventPayload[] = [...runs].map(([runId, run]) => ({ type: "run.interrupted", runId,
    recoveries: [...run.pending.values()].map((item) => ({ ...item,
      status: run.version === 1 && !run.started.has(item.id) ? "not-started" : "unknown" })),
  }));
  return [...repairs, ...[...approvals].map((requestId) => ({ type: "approval.cancelled" as const, requestId, reason: "Process interrupted; approval was not restored" }))];
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function modelStepKey(runId: string, step: number): string {
  return `${runId}:${step}`;
}

function validateToolPresentation(
  presentation: SessionToolPresentation,
): void {
  requireNonEmpty(presentation.runId, "runId");
  requireNonEmpty(presentation.toolCallId, "toolCallId");
  requireNonEmpty(presentation.kind, "kind");
  requirePositiveSafeInteger(presentation.step, "step");
  requirePositiveSafeInteger(presentation.version, "version");
}

function requireNonEmpty(value: string, name: string): void {
  if (value.trim() === "") throw new TypeError(`${name} cannot be empty`);
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function replaySession(events: readonly SessionEvent[]): {
  messages: Message[];
  info: SessionRuntimeInfo;
} {
  const messages: Message[] = [];
  const steeringInputs = new Map<string, UserMessage>();
  const pendingTools = new Map<string, Map<string, ToolCall>>();
  const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let latestModelMeasurement: SessionModelMeasurement | undefined;
  let runtime: RuntimeDescriptor | undefined;
  let runtimeState: unknown;

  for (const event of events) {
    switch (event.type) {
      case "session.created":
        runtime = event.runtime ?? DEFAULT_RUNTIME_DESCRIPTOR;
        break;
      case "runtime.changed":
        validateRuntimeDescriptor(event.runtime);
        runtime = event.runtime;
        runtimeState = structuredClone(event.state);
        break;
      case "runtime.state.saved":
        if (runtime === undefined) throw new Error("Runtime state requires Session creation metadata");
        validateRuntimeDescriptor(event.runtime);
        if (runtime.id !== event.runtime.id || runtime.version !== event.runtime.version || runtime.stateVersion !== event.runtime.stateVersion) throw new Error("Saved runtime state has an incompatible descriptor");
        runtimeState = structuredClone(event.state);
        break;
      case "input.generated":
        messages.push(...event.messages);
        break;
      case "state.updated":
        state[event.key] = event.value;
        break;
      case "run.interrupted":
        for (const recovery of event.recoveries) {
          const error = recovery.status === "not-started"
            ? { code: "TOOL_NOT_EXECUTED", message: "The process stopped before this tool's execution checkpoint. The tool was not executed." }
            : { code: "TOOL_OUTCOME_UNKNOWN", message: "The process stopped without a durable outcome. External effects may have occurred. Do not repeat this operation without verified recovery findings." };
          messages.push({ role: "tool", name: recovery.call.name, toolCallId: recovery.call.id,
            isError: true, content: [{ type: "json", value: error }] });
        }
        break;
      case "recovery.resolved":
        messages.push(event.message);
        break;
      case "input.submitted":
        messages.push(event.message);
        break;
      case "input.steering.queued":
        steeringInputs.set(event.input.inputId, event.input.message);
        break;
      case "input.steering.delivered":
        for (const inputId of event.inputIds) {
          const input = steeringInputs.get(inputId);
          if (input === undefined) throw new Error(`Missing steering input: ${inputId}`);
          messages.push(input);
        }
        break;
      case "assistant.completed":
        messages.push(event.message);
        if (
          event.message.toolCalls !== undefined &&
          event.message.toolCalls.length > 0
        ) {
          pendingTools.set(
            modelStepKey(event.runId, event.step),
            new Map(event.message.toolCalls.map((call) => [call.id, call])),
          );
        }
        if (
          event.usage?.inputTokens !== undefined &&
          event.contextMessageCount !== undefined
        ) {
          latestModelMeasurement = {
            inputTokens: event.usage.inputTokens,
            contextMessageCount: event.contextMessageCount,
          };
        }
        break;
      case "context.compacted":
        messages.splice(0, messages.length, ...event.messages);
        pendingTools.clear();
        latestModelMeasurement = undefined;
        break;
      case "tool.completed":
        messages.push({
          role: "tool",
          toolCallId: event.call.id,
          name: event.call.name,
          content: sessionToolResultContent(event),
        });
        resolvePendingTool(pendingTools, event.runId, event.step, event.call.id);
        break;
      case "tool.failed":
        messages.push({
          role: "tool",
          toolCallId: event.call.id,
          name: event.call.name,
          content: [{ type: "json", value: event.error }],
          isError: true,
        });
        resolvePendingTool(pendingTools, event.runId, event.step, event.call.id);
        break;
      case "run.cancelled":
        for (const [key, calls] of pendingTools) {
          if (!key.startsWith(`${event.runId}:`)) continue;
          messages.push(
            ...[...calls.values()].map((call) =>
              toolCancellationMessage(call, event.reason)
            ),
          );
          pendingTools.delete(key);
        }
        break;
    }
  }

  // Outcomes are durable in completion order, but model messages follow call order.
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    const order = new Map(message.toolCalls.map((call, position) => [call.id, position]));
    let end = index + 1;
    while (messages[end]?.role === "tool") end++;
    const results = messages.slice(index + 1, end);
    results.sort((a, b) => (a.role === "tool" ? order.get(a.toolCallId) ?? Infinity : Infinity) - (b.role === "tool" ? order.get(b.toolCallId) ?? Infinity : Infinity));
    messages.splice(index + 1, results.length, ...results);
  }
  return {
    messages,
    info: { ...(latestModelMeasurement === undefined ? {} : { latestModelMeasurement }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(runtimeState === undefined ? {} : { runtimeState }),
      ...(Object.keys(state).length === 0 ? {} : { state }) },
  };
}

function resolvePendingTool(
  pending: Map<string, Map<string, ToolCall>>,
  runId: string,
  step: number,
  toolCallId: string,
): void {
  const key = modelStepKey(runId, step);
  const calls = pending.get(key);
  if (calls === undefined) return;
  calls.delete(toolCallId);
  if (calls.size === 0) pending.delete(key);
}

function toPermissionSessionEvent(
  event: RecordablePermissionEvent,
): SessionEventPayload {
  if (event.type === "rule.created") return { type: event.type, rule: structuredClone(event.rule) };
  if (event.type === "rule.revoked") return { type: event.type, ruleId: event.ruleId, scopeId: event.scopeId };
  if (event.type === "rule.used") return { type: event.type, ruleId: event.ruleId, scopeId: event.scopeId, decision: event.decision, runId: event.runId, toolCallId: event.toolCallId };
  if (event.type === "approval.requested") {
    const request: SessionApprovalRequest = event.request.grantKey === undefined
      ? {
          id: event.request.id,
          createdAt: event.request.createdAt,
          tool: event.request.tool,
          input: event.request.input,
          runId: event.request.context.runId,
          step: event.request.context.step,
          toolCallId: event.request.context.toolCallId,
          idempotencyKey: event.request.context.idempotencyKey,
        }
      : {
          id: event.request.id,
          createdAt: event.request.createdAt,
          tool: event.request.tool,
          input: event.request.input,
          runId: event.request.context.runId,
          step: event.request.context.step,
          toolCallId: event.request.context.toolCallId,
          idempotencyKey: event.request.context.idempotencyKey,
          grantKey: event.request.grantKey,
        };
    if (event.request.persistent !== undefined) request.persistent = structuredClone(event.request.persistent);
    return { type: "approval.requested", request };
  }
  if (event.type === "approval.resolved") {
    return {
      type: "approval.resolved",
      requestId: event.requestId,
      decision: event.decision,
    };
  }
  return event.reason === undefined
    ? { type: "approval.cancelled", requestId: event.requestId }
    : {
        type: "approval.cancelled",
        requestId: event.requestId,
        reason: event.reason,
      };
}

function toSessionEvent(event: MayEvent): SessionEventPayload | undefined {
  switch (event.type) {
    case "input.generated":
      return { type: event.type, runId: event.runId, step: event.step, messages: [...event.messages], reason: event.reason };
    case "run.budget.exceeded":
      return { type: event.type, runId: event.runId, dimension: event.dimension, limit: event.limit, consumed: event.consumed, budget: event.budget };
    case "tool.started":
      return { type: "tool.started", runId: event.runId, step: event.step, call: event.call, ...(event.input === undefined ? {} : { input: event.input }) };
    case "run.started":
      return event.continuation === true
        ? { type: "run.started", runId: event.runId, continuation: true }
        : { type: "run.started", runId: event.runId };
    case "model.completed":
      return event.usage === undefined
        ? {
            type: "assistant.completed",
            runId: event.runId,
            step: event.step,
            message: event.message,
            contextMessageCount: event.contextMessageCount,
          }
        : {
            type: "assistant.completed",
            runId: event.runId,
            step: event.step,
            message: event.message,
            usage: event.usage,
            contextMessageCount: event.contextMessageCount,
          };
    case "tool.completed":
      return {
        type: "tool.completed",
        runId: event.runId,
        step: event.step,
        call: event.call,
        output: event.output,
        content: event.content,
      };
    case "tool.failed":
      return {
        type: "tool.failed",
        runId: event.runId,
        step: event.step,
        call: event.call,
        error: event.error,
      };
    case "run.completed":
      return {
        type: "run.completed",
        runId: event.runId,
        result: event.result,
      };
    case "run.yielded":
      return { type: "run.yielded", runId: event.runId, result: event.result };
    case "run.failed":
      return {
        type: "run.failed",
        runId: event.runId,
        error: event.error,
      };
    case "run.cancelled":
      return event.reason === undefined
        ? { type: "run.cancelled", runId: event.runId }
        : {
            type: "run.cancelled",
            runId: event.runId,
            reason: event.reason,
          };
    default:
      return undefined;
  }
}

function assertSessionInputOptions(options: { readonly stepInputSource?: unknown }): void {
  if (options.stepInputSource !== undefined) throw new TypeError("Session manages step input through steer(); custom stepInputSource is unsupported");
}

export function createSessionId(): string {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function snapshotRuntimeState(runtime: AgentRuntime): Promise<unknown> {
  const descriptor = runtime.descriptor;
  if (descriptor === undefined || descriptor.stateVersion === undefined) throw new Error("Stateful runtime requires a versioned descriptor");
  validateRuntimeDescriptor(descriptor);
  const state = await runtime.saveState!();
  if (state === undefined) throw new Error("Stateful runtime must save an explicit state value");
  return structuredClone(state);
}

async function closeRejectedRuntime(runtime: AgentRuntime, error: unknown): Promise<never> {
  try { await runtime.close?.(); }
  catch (cleanupError) { throw new AggregateError([error, cleanupError], "Runtime initialization and cleanup both failed", { cause: error }); }
  throw error;
}
