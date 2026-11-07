import type { ContextSnapshot, Message, ModelContextCompactor } from "../core/index.js";

import type { ContextInspection } from "./controller.js";

/** @experimental */
export interface ContextCompactionStrategy {
  readonly name: string;
  compact(
    snapshot: Readonly<ContextSnapshot>,
    options?: ContextCompactionOptions,
  ): ContextCompactionOutput | Promise<ContextCompactionOutput>;
}

/** @experimental */
export interface ContextCompactionOptions {
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly step?: number;
}

/** @experimental */
export interface ContextCompactionDetails {
  readonly messages: readonly Message[];
  readonly effectiveTokens?: number;
  /** Stop the current automatic strategy chain after this strategy. */
  readonly terminal?: boolean;
}

/** @experimental */
export type ContextCompactionOutput = readonly Message[] | ContextCompactionDetails;

/** @experimental */
export interface ContextCompactionResult {
  readonly strategy: string;
  readonly changed: boolean;
  readonly messages: readonly Message[];
  readonly before: ContextInspection;
  readonly after: ContextInspection;
  readonly terminal?: boolean;
}

/** @experimental */
export type ContextCompactionSink = (
  result: ContextCompactionResult,
  options: ContextCompactionOptions,
) => void | Promise<void>;

/** @experimental */
export interface ContextCompactionFailure {
  readonly strategy: string;
  readonly error: Error;
  readonly before: ContextInspection;
  readonly continuing: boolean;
}

/** @experimental */
export type ContextCompactionFailureSink = (failure: ContextCompactionFailure) => void | Promise<void>;

/** @experimental */
export class ContextCompactionExhaustedError extends Error {
  readonly inspection: ContextInspection;
  readonly failures: readonly ContextCompactionFailure[];

  constructor(inspection: ContextInspection, failures: readonly ContextCompactionFailure[] = []) {
    const threshold =
      inspection.compactTriggerTokens === undefined
        ? "the configured threshold"
        : `the ~${inspection.compactTriggerTokens}-token threshold`;
    super(
      `Automatic context compaction exhausted all strategies; ` +
        `context remains at ~${inspection.effectiveTokens} tokens at or above ${threshold}`,
    );
    this.name = "ContextCompactionExhaustedError";
    this.inspection = inspection;
    this.failures = [...failures];
  }
}

/** @experimental */
export class ModelContextCompactionStrategy implements ContextCompactionStrategy {
  readonly name: string;

  constructor(private readonly compactor: ModelContextCompactor) {
    if (compactor.name.trim() === "") {
      throw new Error("model context compactor name cannot be empty");
    }
    this.name = compactor.name;
  }

  async compact(
    snapshot: Readonly<ContextSnapshot>,
    options: ContextCompactionOptions = {},
  ): Promise<ContextCompactionDetails> {
    const result = await this.compactor.compact(snapshot, options);
    return {
      messages: result.messages,
      ...(result.effectiveTokens === undefined ? {} : { effectiveTokens: result.effectiveTokens }),
      terminal: true,
    };
  }
}
