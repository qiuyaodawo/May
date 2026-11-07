import { readRecordedModelRequests, type RecordedModelRequest } from "./requests.js";
import type { ModelRequestSink } from "../core/request-recording.js";
import {
  AsyncEventQueue,
  AsyncStateSerializer,
  isStreamingMayEvent,
  type AgentRuntime,
  type RuntimeDescriptor,
  DEFAULT_RUNTIME_DESCRIPTOR,
  validateRuntimeDescriptor,
  jsonEqual,
  omitUndefined,
  type MayEvent,
  type Message,
  type ContinueOptions,
  type RunHandle,
  type RunOptions,
  type RunCheckpointEvent,
  type UserMessage,
  userMessage,
} from "../core/index.js";

import type {
  RecordablePermissionEvent,
  SessionContextCompaction,
  SessionEvent,
  SessionEventPayload,
  SessionToolPresentation,
  SessionRecovery,
  SessionForkOrigin,
} from "./events.js";
import { readSessionBranchPositions, type SessionBranchPosition } from "./branch.js";
import { SessionSteeringQueue, type SessionSteerOptions, type SessionSteeringInput } from "./steering.js";
import { inspectSessionRunOutcome, type SessionRunOutcome, type SessionRunSelector } from "./outcome.js";
import { SessionHistoryReader, type SessionHistoryQuery, type SessionHistoryPage } from "./history.js";
import { InMemorySessionStore, type SessionStore, validateSessionHistory } from "./store.js";
import { checkpointKey, toPermissionSessionEvent, toSessionEvent } from "./run-observer.js";
import { interruptedRuns, SessionRecoveryRequiredError } from "./recovery.js";
import { modelStepKey, replaySession } from "./replay.js";
import { appendForkHistory } from "./branching.js";
import { adoptRuntimeState, snapshotRuntimeState } from "./runtime-state.js";
import { prepareModelRequest } from "./request-recorder.js";

export { SessionRecoveryRequiredError } from "./recovery.js";

/** @public */
export interface SessionOptions {
  providerBodyRecording?: boolean | undefined;
  requestRecording?: "off" | "required";
  runtime: AgentRuntime;
  store?: SessionStore;
  id?: string;
  metadata?: Record<string, unknown>;
  deferBranchPositions?: boolean;
}

/** @public */
export interface ResumeSessionOptions {
  providerBodyRecording?: boolean | undefined;
  requestRecording?: "off" | "required";
  id: string;
  store: SessionStore;
  deferBranchPositions?: boolean;
  createRuntime(messages: Message[], info: SessionRuntimeInfo): AgentRuntime | Promise<AgentRuntime>;
}

/** @experimental */
export interface SessionForkOptions extends Omit<ResumeSessionOptions, "id"> {
  readonly sourceId: string;
  readonly positionSeq: number;
  readonly id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly stateKeys?: readonly string[];
  readonly transformState?: (key: string, value: unknown) => unknown;
  readonly deferForkReady?: boolean;
}

/** @experimental */
export interface SessionModelMeasurement {
  readonly inputTokens: number;
  readonly contextMessageCount: number;
}

/** @experimental */
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

/** Optional host delivery identity. Duplicates are rejected, not submitted again.
 * @experimental
 */
export interface SessionSubmitOptions extends Omit<RunOptions, "stepInputSource"> {
  readonly stepInputSource?: never;
  readonly inputId?: string;
}

/** Session 的补充输入统一通过 steer() 保存和交付。
 * @experimental
 */
export interface SessionContinueOptions extends Omit<ContinueOptions, "stepInputSource"> {
  readonly stepInputSource?: never;
  /** 宿主提供的持久执行身份，同一个 Session 内只能提交一次。 */
  readonly continuationId?: string;
}

/** @public */
export class Session {
  private requestRecording: "off" | "required" = "off";
  private providerBodyRecording = false;
  private readonly requestRecords = new AsyncStateSerializer();
  private readonly requestDefinitions = new Set<string>();
  private readonly requestAttempts = new Map<string, number>();
  /** @experimental */
  readonly id: string;
  /** @experimental */
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  /** @experimental */
  readonly forkOrigin: SessionForkOrigin | undefined;

  private runtime: AgentRuntime;
  private readonly store: SessionStore;
  private readonly historyReader: SessionHistoryReader;
  private seq: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly records = new AsyncStateSerializer();
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
  private latestRunId: string | undefined;
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
    this.forkOrigin =
      created?.type === "session.created" && created.fork !== undefined ? structuredClone(created.fork) : undefined;
    this.seq = seq;
    this.deferBranchPositions = deferBranchPositions;
    this.steering = new SessionSteeringQueue((event) => this.record(event), history);
    for (const event of history) {
      if (event.type === "model.request.defined") this.requestDefinitions.add(event.id);
      if (event.type === "model.request.prepared") this.requestAttempts.set(event.modelCallId, event.attempt);
      if (!event.type.startsWith("model.") && "runId" in event && typeof event.runId === "string")
        this.latestRunId = event.runId;
      if (event.type === "input.submitted" && event.inputId !== undefined) this.submittedInputIds.add(event.inputId);
    }
  }

  /** @public */
  static async create(options: SessionOptions): Promise<Session> {
    const id = options.id ?? createSessionId();
    const store = options.store ?? new InMemorySessionStore();
    const existing = await store.read(id);

    if (existing.length > 0) {
      throw new Error(`Session "${id}" already exists`);
    }

    const session = new Session(id, options.runtime, store, options.metadata, 0, [], options.deferBranchPositions);
    const runtime = options.runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
    session.requestRecording = requestRecordingMode(options.requestRecording);
    session.providerBodyRecording = options.providerBodyRecording ?? false;
    if (session.requestRecording === "required" && options.runtime.supportsRequestRecording !== true)
      throw new Error("Runtime does not support complete request recording");
    validateRuntimeDescriptor(runtime);
    const initialState =
      options.runtime.saveState === undefined ? undefined : await snapshotRuntimeState(options.runtime);
    const created: SessionEventPayload = {
      type: "session.created",
      runtime: { ...runtime },
      ...(session.metadata === undefined ? {} : { metadata: { ...session.metadata } }),
    };
    await session.record(created);
    if (initialState !== undefined) {
      await session.record({ type: "runtime.state.saved", runtime: { ...runtime }, state: initialState });
    }
    return session;
  }

  /** @public */
  static async resume(options: ResumeSessionOptions): Promise<Session> {
    const events = await new SessionHistoryReader(options.store).readAll(options.id);
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
      const currentDescriptor = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const { state: runtimeState, migrated } = await adoptRuntimeState(
        runtime,
        replay.info.runtime ?? DEFAULT_RUNTIME_DESCRIPTOR,
        replay.info.runtimeState,
      );
      for (const event of repairs) await options.store.append(event);
      if (migrated || !jsonEqual(runtimeState, replay.info.runtimeState)) {
        const change: SessionEvent = {
          ...(migrated
            ? {
                type: "runtime.changed",
                ...(runtimeState === undefined ? {} : { state: structuredClone(runtimeState) }),
              }
            : { type: "runtime.state.saved", state: structuredClone(runtimeState) }),
          runtime: { ...currentDescriptor },
          sessionId: options.id,
          seq: recoveredEvents.length + 1,
          timestamp: Date.now(),
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
      session.requestRecording = requestRecordingMode(options.requestRecording);
      session.providerBodyRecording = options.providerBodyRecording ?? false;
      if (session.requestRecording === "required" && runtime.supportsRequestRecording !== true)
        throw new Error("Runtime does not support complete request recording");
      for (const event of recoveredEvents) {
        if (event.type === "run.interrupted") {
          for (const recovery of event.recoveries) {
            if (recovery.status === "unknown") session.recoveries.set(recovery.id, recovery);
          }
        } else if (event.type === "recovery.resolved") session.recoveries.delete(event.recoveryId);
      }
      for (const runId of new Set(
        session.steering
          .list()
          .filter((input) => input.status === "pending")
          .map((input) => input.runId!),
      )) {
        const terminal = [...recoveredEvents]
          .reverse()
          .find(
            (event) =>
              "runId" in event &&
              event.runId === runId &&
              ["run.completed", "run.yielded", "run.cancelled", "run.failed", "run.interrupted"].includes(event.type),
          );
        await session.steering.finish(
          runId,
          terminal?.type === "run.completed" || terminal?.type === "run.yielded" ? "idle" : "cancelled",
          terminal?.type ?? "interrupted",
        );
      }
      return session;
    } catch (error) {
      return closeRejectedRuntime(runtime, error);
    }
  }

  /** @experimental */
  static async fork(options: SessionForkOptions): Promise<Session> {
    if (options.store.inspect === undefined) throw new Error("Session forking requires read-only store inspection");
    const source = await options.store.inspect(options.sourceId);
    validateSessionHistory(options.sourceId, source);
    const selected = readSessionBranchPositions(source).find(
      (position) => position.positionSeq === options.positionSeq,
    );
    if (selected === undefined || !selected.available)
      throw new Error(selected?.reason ?? "Selected history position has no recoverable state");
    const id = options.id ?? createSessionId();
    if (id === options.sourceId || (await options.store.read(id)).length > 0)
      throw new Error(`Session "${id}" already exists`);
    const history: SessionEvent[] = [];
    const append = (event: SessionEventPayload, timestamp: number) =>
      history.push({ ...structuredClone(event), sessionId: id, seq: history.length + 1, timestamp });
    const created = appendForkHistory(source, options, selected.runId, append);
    const replay = replaySession(history);
    const runtime = await options.createRuntime(replay.messages, replay.info);
    try {
      const currentDescriptor = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const { state, migrated } = await adoptRuntimeState(
        runtime,
        replay.info.runtime ?? DEFAULT_RUNTIME_DESCRIPTOR,
        replay.info.runtimeState,
      );
      if (migrated || state !== undefined)
        append(
          omitUndefined({
            type: migrated ? "runtime.changed" : "runtime.state.saved",
            runtime: { ...currentDescriptor },
            state,
          }) as SessionEventPayload,
          Date.now(),
        );
      for (const event of history) await options.store.append(event);
      if (options.deferForkReady !== true) {
        const ready: SessionEvent = {
          type: "session.fork.ready",
          sessionId: id,
          seq: history.length + 1,
          timestamp: Date.now(),
        };
        await options.store.append(ready);
        history.push(ready);
      }
      const session = new Session(
        id,
        runtime,
        options.store,
        options.metadata ?? created.metadata,
        history.length,
        history,
        options.deferBranchPositions,
      );
      session.requestRecording = requestRecordingMode(options.requestRecording);
      session.providerBodyRecording = options.providerBodyRecording ?? false;
      if (session.requestRecording === "required" && runtime.supportsRequestRecording !== true)
        throw new Error("Runtime does not support complete request recording");
      return session;
    } catch (error) {
      return closeRejectedRuntime(runtime, error);
    }
  }

  /** @experimental */
  async branchPositions(): Promise<readonly SessionBranchPosition[]> {
    return readSessionBranchPositions(await this.history());
  }

  /** @experimental */
  async saveForkReady(): Promise<void> {
    if (this.forkOrigin === undefined) throw new Error("Only a forked Session can save initialization readiness");
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    this.assertIdleRuntime();
    if (this.persistenceFailed) throw new Error("Session persistence failed before branch initialization completed");
    if ((await this.history()).some((event) => event.type === "session.fork.ready")) return;
    await this.record({ type: "session.fork.ready" });
  }

  /** @experimental */
  async saveBranchPosition(
    runId: string,
    options: import("./branch.js").SessionBranchCompletionOptions = {},
  ): Promise<void> {
    if (this.persistenceFailed) throw new Error("Session persistence failed; reopen the Session before branching");
    if (
      this.activeRun !== undefined ||
      this.activeRunObservations.size > 0 ||
      this.settlingRuns > 0 ||
      this.runtimeMutation
    ) {
      throw new Error("Branch positions require completed tool execution and saved Runtime state");
    }
    const history = await this.history();
    const latestStarted = [...history].reverse().find((event) => event.type === "run.started");
    if (latestStarted?.type !== "run.started" || latestStarted.runId !== runId)
      throw new Error("Only the latest completed Run can save a branch position");
    if (history.some((event) => event.type === "run.settled" && event.runId === runId)) return;
    const completed = history.some((event) => event.type === "run.completed" && event.runId === runId);
    const hostCompleted =
      options.allowYielded === true && history.some((event) => event.type === "run.yielded" && event.runId === runId);
    if (!completed && !hostCompleted) return;
    await this.record({ type: "run.settled", runId, ...(hostCompleted ? { hostCompleted: true as const } : {}) });
  }

  /** @experimental */
  submit(options: SessionSubmitOptions): Promise<RunHandle> {
    assertSessionInputOptions(options);
    return this.enqueueRun(() => this.start(options));
  }

  /** @experimental */
  async steer(options: SessionSteerOptions): Promise<SessionSteeringInput> {
    this.assertRecovered();
    if (options.inputId !== undefined && this.submittedInputIds.has(options.inputId))
      throw new Error(`Input already submitted: ${options.inputId}`);
    return this.steering.enqueue(options, this.activeRun?.id);
  }

  /** @experimental */
  listSteeringInputs(): readonly SessionSteeringInput[] {
    return this.steering.list();
  }

  /** @experimental */
  cancelSteeringInputs(reason = "Cancelled by user"): Promise<void> {
    return this.steering.cancel(reason);
  }

  /** @experimental */
  startSteeringInput(
    inputId: string,
    options: Omit<SessionSubmitOptions, "input" | "inputId"> = {},
  ): Promise<RunHandle> {
    assertSessionInputOptions(options);
    const input = this.steering.idle(inputId);
    return this.submit({ ...options, input: input.message, inputId });
  }

  /** Continue the current context without recording a new user input. */
  /** @experimental */
  continue(options: SessionContinueOptions = {}): Promise<RunHandle> {
    assertSessionInputOptions(options);
    return this.enqueueRun(() => this.startContinuation(options));
  }

  private enqueueRun(operation: () => RunHandle | Promise<RunHandle>): Promise<RunHandle> {
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (this.suspendedRuntime !== undefined) throw new Error("Session runtime is suspended");
    if (this.runtimeMutation) throw new Error("Session runtime is changing");
    this.pendingStarts += 1;
    const started = this.tail.then(operation).then(
      (run) => {
        this.pendingStarts -= 1;
        return run;
      },
      (error: unknown) => {
        this.pendingStarts -= 1;
        throw error;
      },
    );
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

  /** @public */
  async history(): Promise<readonly SessionEvent[]> {
    await this.records.idle();
    return this.historyReader.readAll(this.id);
  }

  /** @experimental */
  async inspectRun(selector: SessionRunSelector): Promise<SessionRunOutcome> {
    return inspectSessionRunOutcome(await this.history(), selector);
  }

  /** @experimental */
  async getRuntimeInfo(): Promise<{ readonly messages: Message[]; readonly info: SessionRuntimeInfo }> {
    this.assertIdleRuntime();
    this.runtimeMutation = true;
    try {
      return replaySession(await this.history());
    } finally {
      this.runtimeMutation = false;
    }
  }

  /** @experimental */
  async suspendRuntime(): Promise<void> {
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (this.suspendedRuntime !== undefined) return this.suspendedRuntime.closing;
    this.assertIdleRuntime();
    this.assertRecovered();
    this.runtimeMutation = true;
    try {
      const descriptor = structuredClone(this.runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR);
      validateRuntimeDescriptor(descriptor);
      const state =
        this.runtime.saveState === undefined
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

  /** @experimental */
  async replaceRuntime(runtime: AgentRuntime): Promise<void> {
    const previous = this.runtime;
    let accepted = false;
    let changing = false;
    try {
      if (this.requestRecording === "required" && runtime.supportsRequestRecording !== true)
        throw new Error("Runtime does not support complete request recording");
      this.assertIdleRuntime();
      this.assertRecovered(true);
      this.runtimeMutation = true;
      changing = true;
      const suspended = this.suspendedRuntime;
      if (suspended !== undefined) await suspended.closing;
      if (suspended !== undefined && runtime === previous)
        throw new Error("A suspended runtime requires a new replacement instance");
      const savedDescriptor = suspended?.descriptor ?? this.runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const currentDescriptor = runtime.descriptor ?? DEFAULT_RUNTIME_DESCRIPTOR;
      const saved =
        suspended === undefined
          ? this.runtime.saveState === undefined
            ? replaySession(await this.history()).info.runtimeState
            : await snapshotRuntimeState(this.runtime)
          : structuredClone(suspended.state);
      const { state, migrated } = await adoptRuntimeState(runtime, savedDescriptor, saved);
      if (migrated) {
        await this.record({
          type: "runtime.changed",
          runtime: { ...currentDescriptor },
          ...(state === undefined ? {} : { state: structuredClone(state) }),
        });
      } else if (state !== undefined) {
        if (currentDescriptor.stateVersion === undefined)
          throw new Error("Stateful runtime requires a versioned descriptor");
        await this.record({
          type: "runtime.state.saved",
          runtime: { ...currentDescriptor },
          state: structuredClone(state),
        });
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

  /** @public */
  async closeRuntime(): Promise<void> {
    if (this.runtimeClosing !== undefined) return this.runtimeClosing;
    if (
      this.activeRun !== undefined ||
      this.activeRunObservations.size > 0 ||
      this.settlingRuns > 0 ||
      this.runtimeMutation
    ) {
      throw new Error("Cannot close a runtime during execution or state changes");
    }
    this.runtimeClosed = true;
    this.runtimeClosing = this.suspendedRuntime?.closing ?? Promise.resolve().then(() => this.runtime.close?.());
    return this.runtimeClosing;
  }

  /** @experimental */
  async saveRuntimeState(): Promise<void> {
    this.assertIdleRuntime();
    if (this.runtimeClosed) throw new Error("Session runtime is closed");
    if (this.suspendedRuntime !== undefined) return this.suspendedRuntime.closing;
    this.runtimeMutation = true;
    try {
      await this.persistRuntimeState();
    } finally {
      this.runtimeMutation = false;
    }
  }

  private assertIdleRuntime(): void {
    if (
      this.activeRun !== undefined ||
      this.pendingStarts > 0 ||
      this.activeRunObservations.size > 0 ||
      this.settlingRuns > 0 ||
      this.runtimeMutation
    ) {
      throw new Error("Session runtime requires an idle boundary with no queued Runs");
    }
  }

  private async persistRuntimeState(): Promise<void> {
    if (this.runtime.saveState === undefined) return;
    const state = await snapshotRuntimeState(this.runtime);
    await this.record({
      type: "runtime.state.saved",
      runtime: { ...this.runtime.descriptor! },
      state: structuredClone(state),
    });
  }

  /** @public */
  async queryHistory(query: SessionHistoryQuery = {}): Promise<SessionHistoryPage> {
    await this.records.idle();
    return this.historyReader.query(this.id, query);
  }

  /** @experimental */
  recordPermissionEvent(event: RecordablePermissionEvent): Promise<void> {
    if (event.type === "rule.created" || event.type === "rule.revoked" || event.type === "rule.used") {
      return this.record(toPermissionSessionEvent(event), event.timestamp);
    }
    if (event.type === "approval.requested") {
      const operation = this.waitForModelCompletion(event.request.context.runId, event.request.context.step).then(() =>
        this.record(toPermissionSessionEvent(event), event.timestamp),
      );
      this.approvalRecords.set(event.request.id, operation);
      return operation;
    }

    const previous = this.approvalRecords.get(event.requestId) ?? Promise.resolve();
    const operation = previous.then(() => this.record(toPermissionSessionEvent(event), event.timestamp));
    this.approvalRecords.set(event.requestId, operation);
    void operation
      .finally(() => {
        if (this.approvalRecords.get(event.requestId) === operation) {
          this.approvalRecords.delete(event.requestId);
        }
      })
      .catch(() => undefined);
    return operation;
  }

  /** @experimental */
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

  /** @experimental */
  async recordToolPresentation(presentation: SessionToolPresentation): Promise<void> {
    validateToolPresentation(presentation);
    const snapshot = JSON.parse(JSON.stringify(presentation)) as SessionToolPresentation;
    await this.record({ type: "tool.presentation", ...snapshot });
  }

  private async start(options: SessionSubmitOptions): Promise<RunHandle> {
    this.assertRecovered();
    if (options.inputId !== undefined) {
      if (options.inputId.length === 0 || options.inputId.length > 256)
        throw new TypeError("inputId must be a non-empty string of at most 256 characters");
      if ((await this.history()).some((event) => event.type === "input.submitted" && event.inputId === options.inputId))
        throw new Error(`Input already submitted: ${options.inputId}`);
      const steeringInput = this.steering.get(options.inputId);
      if (steeringInput !== undefined) {
        this.steering.idle(options.inputId);
        const message = typeof options.input === "string" ? userMessage(options.input) : options.input;
        if (JSON.stringify(message) !== JSON.stringify(steeringInput.message))
          throw new Error("Steering input content cannot change when starting execution");
      }
    }
    const runtimeOptions: RunOptions = {
      ...options,
      ...(this.requestRecording === "required" ? { recordRequest: this.recordModelRequest } : {}),
      checkpoint: (event) => this.checkpoint(event, options.checkpoint),
      stepInputSource: ({ runId, step, signal }) => this.steering.deliver(runId, step, signal),
      traceAttributes: {
        ...(options.traceAttributes ?? {}),
        "may.session.id": this.id,
      },
    };
    const input: UserMessage = typeof options.input === "string" ? userMessage(options.input) : options.input;
    if (options.signal?.aborted === true) {
      return this.wrapRun(this.runtime.run(runtimeOptions));
    }
    if (options.inputId !== undefined) this.submittedInputIds.add(options.inputId);
    await this.record(omitUndefined({ type: "input.submitted", message: input, inputId: options.inputId }));
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
      const removeListener = () => externalSignal.removeEventListener("abort", forwardAbort);
      void run.result.then(removeListener, removeListener);
    }
    return run;
  }

  private async startContinuation(options: SessionContinueOptions): Promise<RunHandle> {
    this.assertRecovered();
    const { continuationId, ...runtimeOptions } = options;
    const recordingOptions = this.requestRecording === "required" ? { recordRequest: this.recordModelRequest } : {};
    if (continuationId !== undefined) {
      if (continuationId.trim() === "" || continuationId.length > 256) {
        throw new TypeError("continuationId must be a nonempty string of at most 256 characters");
      }
      if (
        (await this.history()).some(
          (event) => event.type === "continuation.submitted" && event.continuationId === continuationId,
        )
      ) {
        throw new Error(`Continuation already submitted: ${continuationId}`);
      }
      await this.record({ type: "continuation.submitted", continuationId });
    }
    this.assertRecovered();
    return this.wrapRun(
      this.runtime.continue({
        ...runtimeOptions,
        ...recordingOptions,
        checkpoint: (event) => this.checkpoint(event, options.checkpoint, continuationId),
        stepInputSource: ({ runId, step, signal }) => this.steering.deliver(runId, step, signal),
        traceAttributes: {
          ...(options.traceAttributes ?? {}),
          "may.session.id": this.id,
          ...(this.latestRunId === undefined ? {} : { "may.run.resumed_from": this.latestRunId }),
        },
      }),
      continuationId,
    );
  }

  private wrapRun(run: RunHandle, continuationId?: string): RunHandle {
    this.latestRunId = run.id;
    this.activeRun = run;
    const completion = run.result.then(
      async (value) => {
        this.settlingRuns += 1;
        try {
          if (this.activeRun === run) this.activeRun = undefined;
          await this.persistRuntimeState();
          await this.steering.finish(run.id, "idle", value.finishReason === "yielded" ? "yielded" : "completed");
          return value;
        } finally {
          this.settlingRuns -= 1;
        }
      },
      async (error: unknown) => {
        this.settlingRuns += 1;
        try {
          if (this.activeRun === run) this.activeRun = undefined;
          await this.persistRuntimeState();
          await this.steering.finish(run.id, "cancelled", error instanceof Error ? error.message : "Run failed");
          throw error;
        } finally {
          this.settlingRuns -= 1;
        }
      },
    );
    void completion.catch(() => undefined);
    const events = new AsyncEventQueue<MayEvent>({
      maxBufferedValues: 1024,
      isDroppable: isStreamingMayEvent,
    });
    this.finishedRunObservationErrors.clear();
    this.activeRunObservations.add(run.id);
    const observation = this.observeRun(run, events, continuationId);
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
      ...omitUndefined({ traceContext: run.traceContext }),
      cancel: (reason?: string) => run.cancel(reason),
    };
  }

  private async observeRun(run: RunHandle, events: AsyncEventQueue<MayEvent>, continuationId?: string): Promise<void> {
    let observationError: unknown;
    try {
      for await (const event of run.events) {
        if (event.type === "run.failed" && event.error.code === "RUN_CHECKPOINT_FAILED") this.persistenceFailed = true;
        const recorded = toSessionEvent(event);
        const payload =
          recorded?.type === "run.started" && continuationId !== undefined ? { ...recorded, continuationId } : recorded;
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
      const terminalError =
        observationError ?? new Error(`Run "${run.id}" ended before the requested event was observed`);
      this.activeRunObservations.delete(run.id);
      this.finishedRunObservationErrors.set(run.id, terminalError);
      this.rejectModelCompletionWaiters(run.id, terminalError);
      this.clearModelCompletionState(run.id);
      for (const key of this.checkpointed)
        if ((JSON.parse(key) as unknown[])[1] === run.id) this.checkpointed.delete(key);
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

  private record(payload: SessionEventPayload, timestamp = Date.now()): Promise<void> {
    return this.records.run(() => this.recordNow(payload, timestamp));
  }

  private async recordNow(payload: SessionEventPayload, timestamp: number): Promise<void> {
    const seq = this.seq + 1;
    const event: SessionEvent = {
      ...payload,
      sessionId: this.id,
      seq,
      timestamp,
    };
    try {
      await this.store.append(event);
    } catch (error) {
      this.persistenceFailed = true;
      throw error;
    }
    this.seq = seq;
  }

  /** @public */
  listRecoveries(): readonly SessionRecovery[] {
    return [...this.recoveries.values()].map((value) => structuredClone(value));
  }

  /** Persist bounded, application-owned state independently of compactable messages. */
  /** @experimental */
  async recordState(key: string, value: unknown): Promise<void> {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(key)) throw new Error("Invalid session state key");
    const snapshot: unknown = JSON.parse(JSON.stringify(value));
    if (JSON.stringify(snapshot).length > 1_048_576) throw new Error("Session state exceeds 1 MiB");
    await this.record({ type: "state.updated", key, value: snapshot });
  }

  /** The host must verify external effects and describe the finding before continuing. */
  /** @public */
  resolveRecovery(id: string, finding: string): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.persistenceFailed) throw new Error("Session persistence failed; reopen the session before recovery");
      const recovery = this.recoveries.get(id);
      if (recovery === undefined) throw new Error(`Unknown recovery: ${id}`);
      if (finding.trim() === "" || finding.length > 32768)
        throw new Error("Recovery finding must contain 1-32768 characters");
      const message = userMessage(`Verified recovery of tool call ${id} (${recovery.call.name}):\n${finding}`);
      await this.record({ type: "recovery.resolved", recoveryId: id, message });
      try {
        await this.runtime.appendMessages([message]);
      } catch (error) {
        this.persistenceFailed = true;
        throw error;
      }
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

  private async checkpoint(
    event: RunCheckpointEvent,
    extra?: (event: RunCheckpointEvent) => Promise<void>,
    continuationId?: string,
  ): Promise<void> {
    const live = { ...event, timestamp: Date.now(), seq: 0 };
    const payload =
      event.type === "run.started"
        ? { ...event, checkpointVersion: 1 as const, ...omitUndefined({ continuationId }) }
        : toSessionEvent(live);
    if (payload !== undefined) {
      await this.record(payload, live.timestamp);
      this.checkpointed.add(checkpointKey(event));
    }
    await extra?.(event);
  }

  /** @experimental */
  async listModelRequests(
    options: { afterSeq?: number; limit?: number } = {},
  ): Promise<readonly RecordedModelRequest[]> {
    const limit = options.limit ?? 50;
    if (options.afterSeq !== undefined && (!Number.isSafeInteger(options.afterSeq) || options.afterSeq < 0))
      throw new RangeError("afterSeq must be a nonnegative integer");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError("limit must be between 1 and 1000");
    return readRecordedModelRequests(await this.history())
      .filter((request) => request.seq > (options.afterSeq ?? 0))
      .slice(0, limit);
  }

  /** @experimental */
  async getModelRequest(modelCallId: string): Promise<readonly RecordedModelRequest[]> {
    return readRecordedModelRequests(await this.history()).filter((request) => request.modelCallId === modelCallId);
  }

  /** @experimental */
  readonly recordModelRequest: ModelRequestSink = (observation) => {
    const operation = this.requestRecords.run(async () => {
      const identity = { runId: observation.runId, step: observation.step, modelCallId: observation.modelCallId };
      if (observation.type === "prepared") {
        const { batch, added, attempt } = prepareModelRequest(
          observation,
          this.providerBodyRecording,
          this.requestDefinitions,
          this.requestAttempts,
        );
        await this.records.run(async () => {
          const events = batch.map(
            (payload, index) =>
              ({ ...payload, sessionId: this.id, seq: this.seq + index + 1, timestamp: Date.now() }) as SessionEvent,
          );
          if (this.store.appendBatch) await this.store.appendBatch(events);
          else for (const event of events) await this.store.append(event);
          this.seq += events.length;
        });
        for (const definition of added) this.requestDefinitions.add(definition.id);
        this.requestAttempts.set(observation.modelCallId, attempt);
      } else {
        const attempt = this.requestAttempts.get(observation.modelCallId) ?? 0;
        if (attempt === 0) throw new Error("Model outcome has no prepared request");
        await this.record(
          observation.type === "started"
            ? { type: "model.attempt.started", ...identity, attempt }
            : observation.type === "completed"
              ? omitUndefined({
                  type: "model.attempt.completed",
                  ...identity,
                  attempt,
                  durationMs: observation.durationMs,
                  usage: observation.usage,
                })
              : omitUndefined({
                  type: "model.attempt.failed",
                  ...identity,
                  attempt,
                  cancelled: observation.cancelled,
                  errorName: observation.errorName,
                  durationMs: observation.durationMs,
                  httpStatus: observation.httpStatus,
                }),
        );
      }
    });
    return operation.catch((error) => {
      this.persistenceFailed = true;
      throw error;
    });
  };
}

function requestRecordingMode(value: unknown): "off" | "required" {
  if (value === undefined) return "required";
  if (value !== "off" && value !== "required") throw new TypeError("requestRecording must be off or required");
  return value;
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

function validateToolPresentation(presentation: SessionToolPresentation): void {
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

function assertSessionInputOptions(options: { readonly stepInputSource?: unknown }): void {
  if (options.stepInputSource !== undefined)
    throw new TypeError("Session manages step input through steer(); custom stepInputSource is unsupported");
}

/** @experimental */
export function createSessionId(): string {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function closeRejectedRuntime(runtime: AgentRuntime, error: unknown): Promise<never> {
  try {
    await runtime.close?.();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Runtime initialization and cleanup both failed", { cause: error });
  }
  throw error;
}
