import type { Context, Message } from "@may/core";

export interface ContextFactoryOptions {
  readonly instructions?: string;
  readonly messages?: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ContextFactory {
  create(options: ContextFactoryOptions): Context | Promise<Context>;
}
