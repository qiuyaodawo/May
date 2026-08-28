import type { Context, Message } from "@may/core";

import type {
  ContextBudget,
  ContextController,
  ContextMeasurement,
} from "./controller.js";

export interface ContextFactoryOptions {
  readonly instructions?: string;
  readonly messages?: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly budget?: ContextBudget;
  readonly measurement?: ContextMeasurement;
}

export interface ContextFactory {
  create(options: ContextFactoryOptions): ManagedContext | Promise<ManagedContext>;
}

export interface ManagedContext {
  readonly context: Context;
  readonly controller?: ContextController;
}
