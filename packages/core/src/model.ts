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
  readonly responseFormat?: ModelResponseFormat;
}

export type ModelResponseFormat =
  | { readonly type: "json" }
  | { readonly type: "jsonSchema"; readonly name: string; readonly schema: JsonSchema; readonly strict?: boolean };

export interface ModelLimits {
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelContextCompactionResult {
  readonly messages: readonly Message[];
  /** Provider-supplied effective size of the compacted model input. */
  readonly effectiveTokens?: number;
  /** 压缩请求本身也是一次 provider 调用；provider 不上报时该字段缺失。 */
  readonly usage?: Usage;
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
      cost?: import("./pricing.js").UsageCost;
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
  readonly attemptObserver?: import("./telemetry.js").ModelAttemptObserver;
}

export interface Model {
  readonly reportsAttempts?: boolean | undefined;
  readonly capabilityVersion?: string | undefined;
  readonly configuration?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly limits?: ModelLimits | undefined;
  /** Optional provider-native context compaction capability. */
  readonly contextCompactor?: ModelContextCompactor;
  preflight?(request: ModelRequest, options: ModelStreamOptions): Promise<void>;
  stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent>;
}
