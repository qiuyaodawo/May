import { userMessage, type UserMessage } from "@may/core";
import type { SessionEvent, SessionEventPayload } from "./events.js";

export interface SessionSteerOptions {
  readonly input: string | UserMessage;
  readonly inputId?: string;
  readonly runId?: string;
}

export interface SessionSteeringInput {
  readonly inputId: string;
  readonly message: UserMessage;
  readonly runId?: string;
  readonly status: "pending" | "delivered" | "idle" | "cancelled";
  readonly reason?: string;
}

/** 按接收顺序保存补充输入，只有 delivered 输入参与 Context 恢复。 */
export class SessionSteeringQueue {
  private readonly inputs = new Map<string, SessionSteeringInput>();
  private readonly inputIds = new Set<string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly record: (event: SessionEventPayload) => Promise<void>,
    history: readonly SessionEvent[] = [],
  ) {
    for (const event of history) {
      if (event.type === "input.steering.queued") {
        this.inputs.set(event.input.inputId, structuredClone(event.input));
        this.inputIds.add(event.input.inputId);
      }
      if (event.type === "input.steering.delivered") {
        for (const inputId of event.inputIds) this.update(inputId, "delivered");
      }
      if (event.type === "input.steering.finished") {
        for (const inputId of event.inputIds) this.update(inputId, event.status, event.reason);
      }
      if (event.type === "input.submitted" && event.inputId !== undefined && this.inputs.has(event.inputId)) this.update(event.inputId, "delivered");
    }
  }

  list(): readonly SessionSteeringInput[] {
    return structuredClone([...this.inputs.values()]);
  }

  enqueue(options: SessionSteerOptions, activeRunId?: string): Promise<SessionSteeringInput> {
    const inputId = options.inputId ?? `steer_${crypto.randomUUID()}`;
    if (typeof inputId !== "string" || inputId.length === 0 || inputId.length > 256) throw new TypeError("inputId must be a non-empty string of at most 256 characters");
    if (options.runId !== undefined && options.runId !== activeRunId) throw new Error("The target run is no longer active");
    if (this.inputIds.has(inputId)) return Promise.reject(new Error(`Steering input already exists: ${inputId}`));
    const input: SessionSteeringInput = {
      inputId,
      message: structuredClone(typeof options.input === "string" ? userMessage(options.input) : options.input),
      ...(activeRunId === undefined ? {} : { runId: activeRunId }),
      status: activeRunId === undefined ? "idle" : "pending",
    };
    if (input.message.role !== "user" || !Array.isArray(input.message.content)) throw new TypeError("Steering input must be a user message");
    this.inputIds.add(inputId);
    return this.serialize(async () => {
      await this.record({ type: "input.steering.queued", input });
      this.inputs.set(inputId, input);
      return structuredClone(input);
    });
  }

  deliver(runId: string, step: number, signal: AbortSignal): Promise<readonly UserMessage[]> {
    return this.serialize(async () => {
      if (signal.aborted) return [];
      const inputs = [...this.inputs.values()].filter((input) => input.runId === runId && input.status === "pending");
      if (inputs.length === 0) return [];
      await this.record({ type: "input.steering.delivered", runId, step, inputIds: inputs.map((input) => input.inputId) });
      for (const input of inputs) this.update(input.inputId, "delivered");
      return structuredClone(inputs.map((input) => input.message));
    });
  }

  finish(runId: string, status: "idle" | "cancelled", reason: string): Promise<void> {
    return this.serialize(async () => {
      const inputIds = [...this.inputs.values()].filter((input) => input.runId === runId && input.status === "pending").map((input) => input.inputId);
      if (inputIds.length === 0) return;
      await this.record({ type: "input.steering.finished", inputIds, status, reason });
      for (const inputId of inputIds) this.update(inputId, status, reason);
    });
  }

  submitted(inputId: string): void {
    if (this.inputs.has(inputId)) this.update(inputId, "delivered");
  }

  cancel(reason: string): Promise<void> {
    return this.serialize(async () => {
      const inputIds = [...this.inputs.values()].filter(input => input.status === "pending" || input.status === "idle").map(input => input.inputId);
      if (!inputIds.length) return;
      await this.record({ type: "input.steering.finished", inputIds, status: "cancelled", reason });
      for (const inputId of inputIds) this.update(inputId, "cancelled", reason);
    });
  }

  get(inputId: string): SessionSteeringInput | undefined {
    if (this.inputIds.has(inputId) && !this.inputs.has(inputId)) throw new Error(`Steering input acceptance is still in progress: ${inputId}`);
    const input = this.inputs.get(inputId);
    return input === undefined ? undefined : structuredClone(input);
  }

  idle(inputId: string): SessionSteeringInput {
    const input = this.inputs.get(inputId);
    if (input?.status !== "idle") throw new Error(`Steering input is not available to start: ${inputId}`);
    const first = [...this.inputs.values()].find((entry) => entry.status === "idle");
    if (first?.inputId !== inputId) throw new Error(`Start the earlier steering input first: ${first?.inputId}`);
    return structuredClone(input);
  }

  private update(inputId: string, status: SessionSteeringInput["status"], reason?: string): void {
    const input = this.inputs.get(inputId);
    if (input === undefined) throw new Error(`Unknown steering input: ${inputId}`);
    this.inputs.set(inputId, { ...input, status, ...(reason === undefined ? {} : { reason }) });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined);
    void this.tail.catch(() => undefined);
    return result;
  }
}
