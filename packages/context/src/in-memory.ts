import { jsonEqual } from "@may/core";
import type {
  Context,
  ContextSnapshot,
  Message,
  SnapshotOptions,
} from "@may/core";

import { SnapshotContextController } from "./controller.js";
import { PruneOldToolResultsStrategy } from "./prune-old-tool-results.js";
import type {
  ContextFactory,
  ContextFactoryOptions,
  ManagedContext,
} from "./factory.js";

export class InMemoryContextFactory implements ContextFactory {
  create(options: ContextFactoryOptions): ManagedContext {
    const context = new ReplaceableInMemoryContext({
      ...(options.instructionsSource === undefined ? {} : { instructionsSource: options.instructionsSource }),
      ...(options.instructions === undefined
        ? {}
        : { instructions: options.instructions }),
      ...(options.messages === undefined
        ? {}
        : { messages: [...options.messages] }),
      ...(options.metadata === undefined
        ? {}
        : { metadata: { ...options.metadata } }),
    });
    const controller = new SnapshotContextController(context, {
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(options.measurement === undefined
          ? {}
          : { measurement: options.measurement }),
        compactionStrategy: options.compactionStrategy ??
          new PruneOldToolResultsStrategy(),
        replaceMessages: (messages, expectedMessages) =>
          context.replaceMessages(messages, expectedMessages),
        ...(options.autoCompactionStrategies === undefined
          ? {}
          : {
              autoCompactionStrategies: options.autoCompactionStrategies,
            }),
      });
    return {
      context: new ModelViewContext(context, controller),
      controller,
    };
  }
}

class ModelViewContext implements Context {
  constructor(
    private readonly context: ReplaceableInMemoryContext,
    private readonly controller: SnapshotContextController,
  ) {}

  async snapshot(options?: SnapshotOptions): Promise<ContextSnapshot> {
    await this.controller.prepareForModel(options);
    return this.context.snapshot();
  }

  append(messages: Message[]): Promise<void> {
    return this.context.append(messages);
  }
}

class ReplaceableInMemoryContext implements Context {
  private readonly instructionsSource: (() => string) | undefined;
  private readonly instructions: string | undefined;
  private readonly messages: Message[];
  private readonly metadata: Record<string, unknown> | undefined;

  constructor(options: {
    instructionsSource?: () => string;
    instructions?: string;
    messages?: Message[];
    metadata?: Record<string, unknown>;
  }) {
    this.instructions = options.instructions;
    this.instructionsSource = options.instructionsSource;
    this.messages = structuredClone(options.messages ?? []);
    this.metadata = structuredClone(options.metadata);
  }

  async snapshot(): Promise<ContextSnapshot> {
    const instructions = this.instructionsSource?.() ?? this.instructions;
    return {
      messages: structuredClone(this.messages),
      ...(instructions === undefined
        ? {}
        : { instructions }),
      ...(this.metadata === undefined
        ? {}
        : { metadata: structuredClone(this.metadata) }),
    };
  }

  async append(messages: Message[]): Promise<void> {
    this.messages.push(...structuredClone(messages));
  }

  replaceMessages(
    messages: readonly Message[],
    expectedMessages: readonly Message[],
  ): boolean {
    if (!jsonEqual(this.messages, expectedMessages)) {
      return false;
    }
    this.messages.splice(0, this.messages.length, ...structuredClone(messages));
    return true;
  }
}
