import type { Usage } from "./types.js";
import { omitUndefined } from "./omit-undefined.js";
import { resolveUsageTotals } from "./usage-totals.js";
import {
  endTraceSpan,
  setTraceAttributes,
  startTraceSpan,
  type TraceAttributes,
  type TraceContext,
  type TraceError,
  type TraceSpanStatus,
  type Tracer,
} from "./tracing.js";

/** @experimental */
export interface ModelAttemptEnd {
  readonly status: TraceSpanStatus;
  readonly error?: TraceError;
  readonly usage?: Usage;
  readonly completed?: boolean;
}

/** @experimental */
export interface ModelAttemptHandle {
  readonly traceContext?: TraceContext;
  content(kind: "text" | "reasoning" | "tool" | "other"): void;
  end(options: ModelAttemptEnd): void;
}

/** @experimental */
export interface ModelAttemptObserver {
  start(attempt: number): ModelAttemptHandle;
  retryWait?(durationMs: number): void;
}

/** @experimental */
export function createModelAttemptObserver(options: {
  readonly tracer?: Tracer;
  readonly parent?: TraceContext;
  readonly modelCallId: string;
  readonly attributes?: TraceAttributes;
  readonly onContent?: (kind: "text" | "reasoning" | "tool" | "other") => void;
  readonly onRetryWait?: (durationMs: number) => void;
}): ModelAttemptObserver {
  return {
    retryWait(durationMs) {
      if (!Number.isFinite(durationMs) || durationMs < 0)
        throw new RangeError("Retry wait duration must be a non-negative finite number");
      options.onRetryWait?.(durationMs);
    },
    start(attempt) {
      const started = performance.now();
      const span = startTraceSpan(options.tracer, "may.model.attempt", {
        ...omitUndefined({ parent: options.parent }),
        attributes: {
          ...options.attributes,
          "may.model.call_id": options.modelCallId,
          "may.model.attempt_id": `${options.modelCallId}:attempt:${attempt}`,
          "may.model.attempt": attempt,
        },
      });
      let content = false;
      let text = false;
      let ended = false;
      return {
        ...omitUndefined({ traceContext: span?.context }),
        content(kind) {
          if (ended) return;
          if (!content) {
            content = true;
            setTraceAttributes(span, { "may.model.first_content_ms": performance.now() - started });
          }
          if (kind === "text" && !text) {
            text = true;
            setTraceAttributes(span, { "may.model.first_text_ms": performance.now() - started });
          }
          options.onContent?.(kind);
        },
        end(end) {
          if (ended) return;
          ended = true;
          endTraceSpan(
            span,
            omitUndefined({
              status: end.status,
              error: end.error,
              attributes: omitUndefined({
                "may.model.has_content": content,
                "may.model.has_text": text,
                "may.model.completed": end.completed === true,
                "may.model.usage_available": end.usage !== undefined,
                "may.model.usage_complete": resolveUsageTotals(end.usage).complete,
                "may.model.input_tokens": end.usage?.inputTokens,
                "may.model.output_tokens": end.usage?.outputTokens,
                "may.model.total_tokens": end.usage?.totalTokens,
                "may.model.cached_read_tokens": end.usage?.cachedReadTokens,
                "may.model.cached_write_tokens": end.usage?.cachedWriteTokens,
                "may.model.reasoning_tokens": end.usage?.reasoningTokens,
              }),
            }),
          );
        },
      };
    },
  };
}
