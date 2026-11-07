import type { Context, Message } from "../core/index.js";

import type { ContextBudget, ContextController, ContextMeasurement } from "./controller.js";
import type { ContextCompactionStrategy } from "./compaction.js";

/** @experimental */
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

/** @experimental */
export interface ContextFactory {
  create(options: ContextFactoryOptions): ManagedContext | Promise<ManagedContext>;
}

/** @experimental */
export interface ManagedContext {
  readonly context: Context;
  readonly controller?: ContextController;
}
