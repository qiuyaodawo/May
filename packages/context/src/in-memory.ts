import { InMemoryContext, type Context } from "@may/core";

import type { ContextFactory, ContextFactoryOptions } from "./factory.js";

export class InMemoryContextFactory implements ContextFactory {
  create(options: ContextFactoryOptions): Context {
    return new InMemoryContext({
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
  }
}
