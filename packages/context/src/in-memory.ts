import { InMemoryContext, type Context } from "@may/core";

import { SnapshotContextController } from "./controller.js";
import type {
  ContextFactory,
  ContextFactoryOptions,
  ManagedContext,
} from "./factory.js";

export class InMemoryContextFactory implements ContextFactory {
  create(options: ContextFactoryOptions): ManagedContext {
    const context: Context = new InMemoryContext({
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
    return {
      context,
      controller: new SnapshotContextController(context),
    };
  }
}
