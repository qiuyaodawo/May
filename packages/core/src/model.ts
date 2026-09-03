import type {
  AssistantMessage,
  JsonSchema,
  Message,
  Usage,
} from "./types.js";
import type { ContextSnapshot } from "./context.js";
import type { SerializedError } from "./events.js";
import type { TraceContext } from "./tracing.js";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
}

export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ModelLimits {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelContextCompactionResult {
  readonly messages: readonly Message[];
  /** Provider-supplied effective size of the compacted model input. */
  readonly effectiveTokens?: number;
}

export interface ModelContextCompactor {
  readonly name: string;
  compact(
    snapshot: Readonly<ContextSnapshot>,
    options: { readonly signal?: AbortSignal; readonly runId?: string; readonly step?: number },
  ): Promise<ModelContextCompactionResult>;
}

export type ModelEvent =
  | { type: "text.delta"; delta: string }
  | { type: "reasoning.delta"; delta: string }
  | {
      /** A model wrapper is waiting before another attempt of this request. */
      type: "retrying";
      /** The attempt that will start after the delay (one-based). */
      attempt: number;
      /** Total number of attempts allowed for this request. */
      maxAttempts: number;
      delayMs: number;
      error: SerializedError;
    }
  | {
      type: "response.completed";
      message: AssistantMessage;
      usage?: Usage;
    };

export interface ModelStreamOptions {
  readonly signal: AbortSignal;
  /** Populated by May; optional for direct adapter use outside a run. */
  readonly runId?: string;
  /** Populated by May; optional for direct adapter use outside a run. */
  readonly step?: number;
  /** Stable across retries of the same model call. */
  readonly modelCallId?: string;
  /** Current model-call span for explicitly propagated instrumentation. */
  readonly traceContext?: TraceContext;
}

export interface Model {
  readonly limits?: ModelLimits;
  /** Optional provider-native context compaction capability. */
  readonly contextCompactor?: ModelContextCompactor;
  stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent>;
}
