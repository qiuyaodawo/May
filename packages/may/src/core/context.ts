import type { Message } from "./types.js";

/** @experimental */
export interface ContextSnapshot {
  instructions?: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
}

/** @experimental */
export interface AppendOptions {
  runId?: string;
  step?: number;
}

/** @experimental */
export interface SnapshotOptions extends AppendOptions {
  signal?: AbortSignal;
}

/** @experimental */
export interface Context {
  snapshot(options?: SnapshotOptions): Promise<ContextSnapshot>;
  append(messages: Message[], options?: AppendOptions): Promise<void>;
}

/** @experimental */
export interface InMemoryContextOptions {
  instructions?: string;
  messages?: Message[];
  metadata?: Record<string, unknown>;
}

/** @experimental */
export class InMemoryContext implements Context {
  private readonly instructions: string | undefined;
  private readonly messages: Message[];
  private readonly metadata: Record<string, unknown> | undefined;

  constructor(options: InMemoryContextOptions = {}) {
    this.instructions = options.instructions;
    this.messages = structuredClone(options.messages ?? []);
    this.metadata = structuredClone(options.metadata);
  }

  async snapshot(options?: SnapshotOptions): Promise<ContextSnapshot> {
    options?.signal?.throwIfAborted();
    const snapshot: ContextSnapshot = { messages: structuredClone(this.messages) };

    if (this.instructions !== undefined) {
      snapshot.instructions = this.instructions;
    }

    if (this.metadata !== undefined) {
      snapshot.metadata = structuredClone(this.metadata);
    }

    return snapshot;
  }

  async append(messages: Message[]): Promise<void> {
    this.messages.push(...structuredClone(messages));
  }
}
