import type { TraceAttributes, TraceContext, TraceError, TraceSpanStatus } from "@sortedyuan/may/core";

/** @experimental */
export interface TraceSpanEventData {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes: TraceAttributes;
}

/**
 * Immutable completed span delivered to processors and exporters.
 * @experimental
 */
export interface FinishedTraceSpan {
  readonly name: string;
  readonly context: TraceContext;
  readonly parentSpanId?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly durationMs: number;
  readonly status: TraceSpanStatus;
  readonly attributes: TraceAttributes;
  readonly events: readonly TraceSpanEventData[];
  readonly error?: TraceError;
}

/**
 * Synchronous ingestion boundary; processors own any asynchronous buffering.
 * @experimental
 */
export interface SpanProcessor {
  onEnd(span: FinishedTraceSpan): void;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

/** @experimental */
export interface SpanExporter {
  export(spans: readonly FinishedTraceSpan[]): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

/** @experimental */
export interface TraceIdGenerator {
  generateTraceId(): string;
  generateSpanId(): string;
}

/** @experimental */
export interface TraceSamplingInput {
  readonly name: string;
  readonly context: TraceContext;
  readonly parent?: TraceContext;
  readonly attributes: TraceAttributes;
}

/** @experimental */
export type TraceSampler = (input: TraceSamplingInput) => boolean;

/** @experimental */
export type ObservabilityErrorHandler = (error: unknown) => void;

/** @experimental */
export interface StartedTraceSpan {
  readonly name: string;
  readonly context: TraceContext;
  readonly parentSpanId?: string;
  readonly startTime: number;
  readonly attributes: TraceAttributes;
}

/** @experimental */
export interface SpanObserver {
  onStart(span: StartedTraceSpan): void;
  onEnd(span: FinishedTraceSpan): void;
}

/** @experimental */
export interface MetricRecorder {
  record(record: import("@sortedyuan/may/core").MetricRecord): void;
}
