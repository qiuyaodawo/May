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
  SessionEvent,
  SessionEventPayload,
} from "./events.js";
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
  createRuntime(messages: Message[]): May | Promise<May>;
}

export class Session {
  readonly id: string;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;

  private readonly runtime: May;
  private readonly store: SessionStore;
  private seq: number;
  private tail: Promise<void> = Promise.resolve();

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
    const events = await options.store.read(options.id);
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

    const messages = replayMessages(events);
    const runtime = await options.createRuntime(messages);
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
    return this.store.read(this.id);
  }

  recordPermissionEvent(event: RecordablePermissionEvent): Promise<void> {
    return this.record(toPermissionSessionEvent(event), event.timestamp);
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
        events.push(event);
      }
    } finally {
      events.close();
    }
  }

  private async record(
    payload: SessionEventPayload,
    timestamp = Date.now(),
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

function replayMessages(events: readonly SessionEvent[]): Message[] {
  const messages: Message[] = [];

  for (const event of events) {
    switch (event.type) {
      case "input.submitted":
      case "assistant.completed":
        messages.push(event.message);
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

  return messages;
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
          }
        : {
            type: "assistant.completed",
            runId: event.runId,
            step: event.step,
            message: event.message,
            usage: event.usage,
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
