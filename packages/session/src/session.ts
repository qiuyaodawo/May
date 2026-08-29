import {
  AsyncEventQueue,
  type May,
  type MayEvent,
  type Message,
  type RunHandle,
  type RunOptions,
  type UserMessage,
  userMessage,
} from "@may/core";

import type {
  RecordablePermissionEvent,
  SessionApprovalRequest,
  SessionContextCompaction,
  SessionEvent,
  SessionEventPayload,
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
  readonly latestModelMeasurement?: SessionModelMeasurement;
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
  private readonly approvalRecords = new Map<string, Promise<void>>();

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

    const replay = replaySession(events);
    const runtime = await options.createRuntime(replay.messages, replay.info);
    return new Session(
      options.id,
      runtime,
      options.store,
      created.metadata,
      events.length,
    );
  }

  submit(options: RunOptions): Promise<RunHandle> {
    const started = this.tail.then(() => this.start(options));
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
  ): Promise<void> {
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

  private async start(options: RunOptions): Promise<RunHandle> {
    const input: UserMessage = typeof options.input === "string"
      ? userMessage(options.input)
      : options.input;
    await this.record({ type: "input.submitted", message: input });

    const run = this.runtime.run(options);
    const events = new AsyncEventQueue<MayEvent>();
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
      cancel: (reason?: string) => run.cancel(reason),
    };
  }

  private async observeRun(
    run: RunHandle,
    events: AsyncEventQueue<MayEvent>,
  ): Promise<void> {
    try {
      for await (const event of run.events) {
        const payload = toSessionEvent(event);
        if (payload !== undefined) {
          await this.record(payload, event.timestamp);
        }
        if (event.type === "model.completed") {
          this.markModelCompleted(event.runId, event.step);
        }
        events.push(event);
      }
    } catch (error) {
      this.rejectModelCompletionWaiters(run.id, error);
      throw error;
    } finally {
      this.clearModelCompletionState(run.id);
      events.close();
    }
  }

  private waitForModelCompletion(runId: string, step: number): Promise<void> {
    const key = modelStepKey(runId, step);
    if (this.completedModelSteps.has(key)) return Promise.resolve();

    let waiter = this.modelCompletionWaiters.get(key);
    if (waiter === undefined) {
      waiter = createDeferred<void>();
      this.modelCompletionWaiters.set(key, waiter);
    }
    return waiter.promise;
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
  }

  private clearModelCompletionState(runId: string): void {
    const prefix = `${runId}:`;
    for (const key of this.completedModelSteps) {
      if (key.startsWith(prefix)) this.completedModelSteps.delete(key);
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
    const event: SessionEvent = {
      ...payload,
      sessionId: this.id,
      seq: ++this.seq,
      timestamp,
    };
    await this.store.append(event);
  }
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

function replaySession(events: readonly SessionEvent[]): {
  messages: Message[];
  info: SessionRuntimeInfo;
} {
  const messages: Message[] = [];
  let latestModelMeasurement: SessionModelMeasurement | undefined;

  for (const event of events) {
    switch (event.type) {
      case "input.submitted":
        messages.push(event.message);
        break;
      case "assistant.completed":
        messages.push(event.message);
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
        latestModelMeasurement = undefined;
        break;
      case "tool.completed":
        messages.push({
          role: "tool",
          toolCallId: event.call.id,
          name: event.call.name,
          content: [{ type: "json", value: event.output }],
        });
        break;
      case "tool.failed":
        messages.push({
          role: "tool",
          toolCallId: event.call.id,
          name: event.call.name,
          content: [{ type: "json", value: event.error }],
          isError: true,
        });
        break;
    }
  }

  return {
    messages,
    info: latestModelMeasurement === undefined
      ? {}
      : { latestModelMeasurement },
  };
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
    case "run.started":
      return { type: "run.started", runId: event.runId };
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
