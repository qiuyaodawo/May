import type {
  TraceAttributes,
  TraceContext,
  TraceError,
  TraceSpanStatus,
} from "@may/core";

export interface TraceSpanEventData {
  readonly name: string;
  readonly timestamp: number;
  readonly attributes: TraceAttributes;
}

/** Immutable completed span delivered to processors and exporters. */
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

/** Synchronous ingestion boundary; processors own any asynchronous buffering. */
export interface SpanProcessor {
  onEnd(span: FinishedTraceSpan): void;
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

export interface SpanExporter {
  export(spans: readonly FinishedTraceSpan[]): void | Promise<void>;
  shutdown?(): void | Promise<void>;
}

export interface TraceIdGenerator {
  generateTraceId(): string;
  generateSpanId(): string;
}

export interface TraceSamplingInput {
  readonly name: string;
  readonly context: TraceContext;
  readonly parent?: TraceContext;
  readonly attributes: TraceAttributes;
}

export type TraceSampler = (input: TraceSamplingInput) => boolean;

export type ObservabilityErrorHandler = (error: unknown) => void;
