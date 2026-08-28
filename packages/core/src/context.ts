import type { Message } from "./types.js";

export interface ContextSnapshot {
  instructions?: string;
  messages: Message[];
  metadata?: Record<string, unknown>;
}

export interface AppendOptions {
  runId?: string;
  step?: number;
}

export interface SnapshotOptions extends AppendOptions {
  signal?: AbortSignal;
}

export interface Context {
  snapshot(options?: SnapshotOptions): Promise<ContextSnapshot>;
  append(messages: Message[], options?: AppendOptions): Promise<void>;
}

export interface InMemoryContextOptions {
  instructions?: string;
  messages?: Message[];
  metadata?: Record<string, unknown>;
}

export class InMemoryContext implements Context {
  private readonly instructions: string | undefined;
  private readonly messages: Message[];
  private readonly metadata: Record<string, unknown> | undefined;

  constructor(options: InMemoryContextOptions = {}) {
    this.instructions = options.instructions;
    this.messages = [...(options.messages ?? [])];
    this.metadata = options.metadata;
  }

  async snapshot(): Promise<ContextSnapshot> {
    const snapshot: ContextSnapshot = { messages: [...this.messages] };

    if (this.instructions !== undefined) {
      snapshot.instructions = this.instructions;
    }

    if (this.metadata !== undefined) {
      snapshot.metadata = { ...this.metadata };
    }

    return snapshot;
  }

  async append(messages: Message[]): Promise<void> {
    this.messages.push(...messages);
  }
}
