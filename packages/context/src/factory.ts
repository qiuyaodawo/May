import type { Context, Message } from "@may/core";

import type {
  ContextBudget,
  ContextController,
  ContextMeasurement,
} from "./controller.js";
import type { ContextCompactionStrategy } from "./compaction.js";

export interface ContextFactoryOptions {
  readonly instructions?: string;
  /** Dynamic host instructions, included in both inspection and model snapshots. */
  readonly instructionsSource?: () => string;
  readonly messages?: readonly Message[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly budget?: ContextBudget;
  readonly measurement?: ContextMeasurement;
  readonly compactionStrategy?: ContextCompactionStrategy;
  readonly autoCompactionStrategies?: readonly ContextCompactionStrategy[];
}

export interface ContextFactory {
  create(options: ContextFactoryOptions): ManagedContext | Promise<ManagedContext>;
}

export interface ManagedContext {
  readonly context: Context;
  readonly controller?: ContextController;
}
