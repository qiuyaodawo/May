import type {
  ContextSnapshot,
  Message,
  ModelContextCompactor,
} from "@may/core";

import type { ContextInspection } from "./controller.js";

export interface ContextCompactionStrategy {
  readonly name: string;
  compact(
    snapshot: Readonly<ContextSnapshot>,
    options?: ContextCompactionOptions,
  ): ContextCompactionOutput | Promise<ContextCompactionOutput>;
}

export interface ContextCompactionOptions {
  readonly signal?: AbortSignal;
  readonly runId?: string;
  readonly step?: number;
}

export interface ContextCompactionDetails {
  readonly messages: readonly Message[];
  readonly effectiveTokens?: number;
  /** Stop the current automatic strategy chain after this strategy. */
  readonly terminal?: boolean;
}

export type ContextCompactionOutput =
  | readonly Message[]
  | ContextCompactionDetails;

export interface ContextCompactionResult {
  readonly strategy: string;
  readonly changed: boolean;
  readonly messages: readonly Message[];
  readonly before: ContextInspection;
  readonly after: ContextInspection;
  readonly terminal?: boolean;
}

export type ContextCompactionSink = (
  result: ContextCompactionResult,
) => void | Promise<void>;

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
      ...(result.effectiveTokens === undefined
        ? {}
        : { effectiveTokens: result.effectiveTokens }),
      terminal: true,
    };
  }
}
