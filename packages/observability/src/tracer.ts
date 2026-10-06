import type {
  TraceAttributes,
  TraceContext,
  TraceSpan,
  TraceSpanEndOptions,
  TraceSpanStartOptions,
  Tracer,
} from "@may/core";

import type {
  FinishedTraceSpan,
  ObservabilityErrorHandler,
  SpanProcessor,
  TraceIdGenerator,
  TraceSampler,
  TraceSpanEventData,
  SpanObserver,
  MetricRecorder,
} from "./types.js";
import { boundedAttributes, telemetryLimits, type TelemetryLimits } from "./limits.js";
import { SpanMetrics } from "./metrics.js";

export interface BasicTracerOptions {
  readonly processor: SpanProcessor;
  readonly resourceAttributes?: TraceAttributes;
  readonly sampler?: TraceSampler;
  readonly clock?: () => number;
  readonly idGenerator?: TraceIdGenerator;
  readonly onError?: ObservabilityErrorHandler;
  readonly metrics?: MetricRecorder;
  readonly observer?: SpanObserver;
  readonly limits?: TelemetryLimits;
}

/**
 * A small May-native tracer. It records completed spans synchronously into a
 * processor, while processors isolate asynchronous export from Agent work.
 */
export class BasicTracer implements Tracer {
  private readonly processor: SpanProcessor;
  private readonly resourceAttributes: TraceAttributes;
  private readonly sampler: TraceSampler;
  private readonly clock: () => number;
  private readonly idGenerator: TraceIdGenerator;
  private readonly onError: ObservabilityErrorHandler | undefined;
  private readonly metrics: MetricRecorder | undefined;
  private readonly observers: readonly SpanObserver[];
  private readonly limits: Required<TelemetryLimits>;

  constructor(options: BasicTracerOptions) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("BasicTracer options must be an object");
    }
    if (typeof options.processor?.onEnd !== "function") {
      throw new TypeError("BasicTracer requires a SpanProcessor");
    }
    this.processor = options.processor;
    this.limits = telemetryLimits(options.limits);
    this.resourceAttributes = snapshotAttributes(
      options.resourceAttributes ?? {},
    );
    this.sampler = options.sampler ?? alwaysOnSampler;
    this.clock = options.clock ?? Date.now;
    this.idGenerator = options.idGenerator ?? randomTraceIdGenerator;
    this.onError = options.onError;
    this.metrics = options.metrics;
    this.observers = [options.observer, options.metrics === undefined ? undefined : new SpanMetrics(options.metrics)].filter((value): value is SpanObserver => value !== undefined);
  }

  recordMetric(record: import("@may/core").MetricRecord): void { this.metrics?.record(record); }

  startSpan(name: string, options: TraceSpanStartOptions = {}): TraceSpan {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("span name must be a non-empty string");
    }
    if (name.length > 128) throw new RangeError("Span name exceeds limit");
    const attributes = boundedAttributes({
      ...this.resourceAttributes,
      ...(options.attributes ?? {}),
    }, this.limits);
    const traceId = options.parent?.traceId ?? this.idGenerator.generateTraceId();
    const spanId = this.idGenerator.generateSpanId();
    const samplingContext: TraceContext = { traceId, spanId };
    const context: TraceContext = Object.freeze({
      traceId,
      spanId,
      sampled: options.parent?.sampled ?? this.sampler({
        name,
        context: samplingContext,
        ...(options.parent === undefined ? {} : { parent: options.parent }),
        attributes,
      }),
    });
    const sampled = context.sampled === true;
    return new BasicTraceSpan({
      name,
      context,
      ...(options.parent === undefined
        ? {}
        : { parentSpanId: options.parent.spanId }),
      attributes,
      sampled,
      processor: this.processor,
      clock: this.clock,
      observers: this.observers,
      limits: this.limits,
      ...(this.onError === undefined ? {} : { onError: this.onError }),
    });
  }
}

interface BasicTraceSpanOptions {
  readonly name: string;
  readonly context: TraceContext;
  readonly parentSpanId?: string;
  readonly attributes: TraceAttributes;
  readonly sampled: boolean;
  readonly processor: SpanProcessor;
  readonly clock: () => number;
  readonly onError?: ObservabilityErrorHandler;
  readonly observers: readonly SpanObserver[];
  readonly limits: Required<TelemetryLimits>;
}

class BasicTraceSpan implements TraceSpan {
  readonly context: TraceContext;

  private readonly name: string;
  private readonly parentSpanId: string | undefined;
  private readonly sampled: boolean;
  private readonly processor: SpanProcessor;
  private readonly clock: () => number;
  private readonly onError: ObservabilityErrorHandler | undefined;
  private readonly startTime: number;
  private readonly attributes: Record<string, import("@may/core").TraceAttributeValue>;
  private readonly events: TraceSpanEventData[] = [];
  private ended = false;
  private readonly observers: readonly SpanObserver[];
  private readonly limits: Required<TelemetryLimits>;

  constructor(options: BasicTraceSpanOptions) {
    this.name = options.name;
    this.context = options.context;
    this.parentSpanId = options.parentSpanId;
    this.sampled = options.sampled;
    this.processor = options.processor;
    this.clock = options.clock;
    this.onError = options.onError;
    this.startTime = options.clock();
    this.attributes = { ...options.attributes };
    this.observers = options.observers;
    this.limits = options.limits;
    for (const observer of this.observers) {
      try { observer.onStart({ name: this.name, context: this.context, startTime: this.startTime, attributes: options.attributes, ...(this.parentSpanId === undefined ? {} : { parentSpanId: this.parentSpanId }) }); }
      catch (error) { reportError(this.onError, error); }
    }
  }

  setAttributes(attributes: TraceAttributes): void {
    if (this.ended) return;
    Object.assign(this.attributes, boundedAttributes({ ...this.attributes, ...attributes }, this.limits));
  }

  addEvent(name: string, attributes: TraceAttributes = {}): void {
    if (this.ended) return;
    if (typeof name !== "string" || name.trim() === "" || name.length > 128) {
      throw new TypeError("span event name must be a non-empty string");
    }
    this.events.push(Object.freeze({
      name,
      timestamp: this.clock(),
      attributes: boundedAttributes(attributes, this.limits),
    }));
    if (this.events.length > this.limits.maxEvents) this.events.shift();
  }

  end(options: TraceSpanEndOptions = {}): void {
    if (this.ended) return;

    if (options.attributes !== undefined) {
      Object.assign(this.attributes, boundedAttributes({ ...this.attributes, ...options.attributes }, this.limits));
    }
    this.ended = true;
    const endTime = this.clock();
    const status = options.status ?? (options.error === undefined ? "ok" : "error");
    const span: FinishedTraceSpan = Object.freeze({
      name: this.name,
      context: this.context,
      ...(this.parentSpanId === undefined
        ? {}
        : { parentSpanId: this.parentSpanId }),
      startTime: this.startTime,
      endTime,
      durationMs: Math.max(0, endTime - this.startTime),
      status,
      attributes: snapshotAttributes(this.attributes),
      events: Object.freeze([...this.events]),
      ...(options.error === undefined
        ? {}
        : { error: Object.freeze({ ...options.error }) }),
    });

    for (const observer of this.observers) {
      try { observer.onEnd(span); } catch (error) { reportError(this.onError, error); }
    }
    if (!this.sampled) return;
    try {
      this.processor.onEnd(span);
    } catch (error) {
      reportError(this.onError, error);
    }
  }
}

export const alwaysOnSampler: TraceSampler = () => true;
export const alwaysOffSampler: TraceSampler = () => false;

/** Deterministic trace-id sampling; child spans inherit the parent decision. */
export function ratioSampler(ratio: number): TraceSampler {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new RangeError("sampling ratio must be between 0 and 1");
  }
  if (ratio === 0) return alwaysOffSampler;
  if (ratio === 1) return alwaysOnSampler;
  return ({ context }) => {
    const prefix = context.traceId.slice(0, 8);
    const value = Number.parseInt(prefix, 16);
    if (!Number.isFinite(value)) return false;
    return value / 0xffffffff < ratio;
  };
}

export const randomTraceIdGenerator: TraceIdGenerator = {
  generateTraceId: () => randomHex(16),
  generateSpanId: () => randomHex(8),
};

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function snapshotAttributes(attributes: TraceAttributes): TraceAttributes {
  const result: Record<string, import("@may/core").TraceAttributeValue> = {};
  for (const [name, value] of Object.entries(attributes)) {
    result[name] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(result);
}

function reportError(
  handler: ObservabilityErrorHandler | undefined,
  error: unknown,
): void {
  try {
    handler?.(error);
  } catch {
    // 遥测错误处理器失败时保持 Agent 执行。
  }
}
