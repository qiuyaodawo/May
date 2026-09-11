import {
  AsyncEventQueue,
  isStreamingMayEvent,
  type May,
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
} from "./events.js";
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
  runtime: May;
  store?: SessionStore;
  id?: string;
  metadata?: Record<string, unknown>;
}

export interface ResumeSessionOptions {
  id: string;
  store: SessionStore;
  createRuntime(
    messages: Message[],
    info: SessionRuntimeInfo,
  ): May | Promise<May>;
}

export interface SessionModelMeasurement {
  readonly inputTokens: number;
  readonly contextMessageCount: number;
}

export interface SessionRuntimeInfo {
  readonly state?: Readonly<Record<string, unknown>>;
  readonly latestModelMeasurement?: SessionModelMeasurement;
}

/** Optional host delivery identity. Duplicates are rejected, not submitted again. */
export interface SessionSubmitOptions extends RunOptions {
  readonly inputId?: string;
}

export class Session {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;

  private readonly runtime: May;
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

  private constructor(
    id: string,
    runtime: May,
    store: SessionStore,
    metadata: Record<string, unknown> | undefined,
    seq: number,
  ) {
    this.id = id;
    this.runtime = runtime;
    this.store = store;
    this.historyReader = new SessionHistoryReader(store);
    this.metadata = metadata === undefined ? undefined : { ...metadata };
    this.seq = seq;
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
    );
    const created: SessionEventPayload = session.metadata === undefined
      ? { type: "session.created" }
      : { type: "session.created", metadata: { ...session.metadata } };
    await session.record(created);
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

    const recoveredEvents = [...events];
    for (const payload of interruptedRuns(events)) {
      const event = { ...payload, sessionId: options.id, seq: recoveredEvents.length + 1, timestamp: Date.now() };
      await options.store.append(event);
      recoveredEvents.push(event);
    }
    const replay = replaySession(recoveredEvents);
    const runtime = await options.createRuntime(replay.messages, replay.info);
    const session = new Session(
      options.id,
      runtime,
      options.store,
      created.metadata,
      recoveredEvents.length,
    );
    for (const event of recoveredEvents) {
      if (event.type === "run.interrupted") {
        for (const recovery of event.recoveries) {
          if (recovery.status === "unknown") session.recoveries.set(recovery.id, recovery);
        }
      } else if (event.type === "recovery.resolved") session.recoveries.delete(event.recoveryId);
    }
    return session;
  }

  submit(options: SessionSubmitOptions): Promise<RunHandle> {
    const started = this.tail.then(() => this.start(options));
    return this.queue(started);
  }

  /** Continue the current context without recording a new user input. */
  continue(options: ContinueOptions = {}): Promise<RunHandle> {
    const started = this.tail.then(() => this.startContinuation(options));
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

  async queryHistory(
    query: SessionHistoryQuery = {},
  ): Promise<SessionHistoryPage> {
    await this.recordTail;
    return this.historyReader.query(this.id, query);
  }

  recordPermissionEvent(event: RecordablePermissionEvent): Promise<void> {
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
    await this.record({ type: "tool.presentation", ...presentation });
  }

  private async start(options: SessionSubmitOptions): Promise<RunHandle> {
    this.assertRecovered();
    if (options.inputId !== undefined) {
      if (typeof options.inputId !== "string" || options.inputId.length === 0 || options.inputId.length > 256) throw new TypeError("inputId must be a non-empty string of at most 256 characters");
      if ((await this.history()).some((event) => event.type === "input.submitted" && event.inputId === options.inputId)) throw new Error(`Input already submitted: ${options.inputId}`);
    }
    const runtimeOptions: RunOptions = {
      ...options,
      checkpoint: (event) => this.checkpoint(event, options.checkpoint),
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
    await this.record({ type: "input.submitted", message: input, ...(options.inputId === undefined ? {} : { inputId: options.inputId }) });

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

  private startContinuation(options: ContinueOptions): RunHandle {
    this.assertRecovered();
    return this.wrapRun(this.runtime.continue({
      ...options,
      checkpoint: (event) => this.checkpoint(event, options.checkpoint),
      traceAttributes: {
        ...(options.traceAttributes ?? {}),
        "may.session.id": this.id,
      },
    }));
  }

  private wrapRun(run: RunHandle): RunHandle {
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
      return run.result;
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

  private assertRecovered(): void {
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
  const pendingTools = new Map<string, Map<string, ToolCall>>();
  const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let latestModelMeasurement: SessionModelMeasurement | undefined;

  for (const event of events) {
    switch (event.type) {
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
          content: [{ type: "json", value: event.output }],
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

  return {
    messages,
    info: { ...(latestModelMeasurement === undefined ? {} : { latestModelMeasurement }),
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
    case "run.budget.exceeded":
      return { type: event.type, runId: event.runId, dimension: event.dimension, limit: event.limit, consumed: event.consumed, budget: event.budget };
    case "tool.started":
      return { type: "tool.started", runId: event.runId, step: event.step, call: event.call };
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

function createSessionId(): string {
  return `session_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
