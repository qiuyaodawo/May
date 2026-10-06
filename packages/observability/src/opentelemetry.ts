import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Attributes, type Meter, type Tracer as OtelTracer } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor as OtelBatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import type { MetricRecord, TraceAttributes, TraceSpan, TraceSpanStartOptions, Tracer } from "@may/core";
import { boundedAttributes, telemetryLimits, type TelemetryLimits } from "./limits.js";
import { metricAttributes, SpanMetrics } from "./metrics.js";
import type { FinishedTraceSpan, MetricRecorder, ObservabilityErrorHandler, SpanObserver, TraceSpanEventData } from "./types.js";

export class OpenTelemetryMetricRecorder implements MetricRecorder {
  private readonly instruments = new Map<string, { record: MetricRecord; instrument: ReturnType<Meter["createCounter"]> | ReturnType<Meter["createHistogram"]> | ReturnType<Meter["createGauge"]> }>();
  private readonly series = new Set<string>();
  private overflow = 0;
  constructor(private readonly meter: Meter, private readonly maxSeries = 1_024) {
    if (!Number.isSafeInteger(maxSeries) || maxSeries < 1) throw new RangeError("maxSeries must be positive");
  }
  get droppedSeries(): number { return this.overflow; }
  record(record: MetricRecord): void {
    if (!Number.isFinite(record.value)) throw new TypeError("Metric value must be finite");
    const attributes = metricAttributes(record.attributes ?? {});
    const series = JSON.stringify([record.name, Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))]);
    if (!this.series.has(series)) {
      if (this.series.size >= this.maxSeries) { this.overflow += 1; return; }
      this.series.add(series);
    }
    let entry = this.instruments.get(record.name);
    if (entry === undefined) {
      const options = record.unit === undefined ? {} : { unit: record.unit };
      const instrument = record.kind === "counter" ? this.meter.createCounter(record.name, options)
        : record.kind === "updown" ? this.meter.createUpDownCounter(record.name, options)
        : record.kind === "gauge" ? this.meter.createGauge(record.name, options)
        : this.meter.createHistogram(record.name, options);
      entry = { record, instrument };
      this.instruments.set(record.name, entry);
    }
    if (entry.record.kind !== record.kind || entry.record.unit !== record.unit) throw new TypeError("Metric instrument kind and unit must remain consistent");
    if ("add" in entry.instrument) entry.instrument.add(record.value, otelAttributes(attributes));
    else entry.instrument.record(record.value, otelAttributes(attributes));
  }
}

export interface OpenTelemetryTracerOptions {
  readonly tracer: OtelTracer;
  readonly metrics?: MetricRecorder;
  readonly observer?: SpanObserver;
  readonly limits?: TelemetryLimits;
  readonly resourceAttributes?: TraceAttributes;
  readonly onError?: ObservabilityErrorHandler;
}

export class OpenTelemetryTracer implements Tracer {
  private readonly limits: Required<TelemetryLimits>;
  private readonly observers: readonly SpanObserver[];
  constructor(private readonly options: OpenTelemetryTracerOptions) {
    this.limits = telemetryLimits(options.limits);
    this.observers = [options.observer, options.metrics === undefined ? undefined : new SpanMetrics(options.metrics)].filter((value): value is SpanObserver => value !== undefined);
  }
  recordMetric(record: MetricRecord): void { this.options.metrics?.record(record); }
  startSpan(name: string, options: TraceSpanStartOptions = {}): TraceSpan {
    if (!name || name.length > 128) throw new TypeError("Invalid span name");
    let attributes = boundedAttributes({ ...this.options.resourceAttributes, ...options.attributes }, this.limits);
    const parent = options.parent;
    const parentContext = parent === undefined ? ROOT_CONTEXT : trace.setSpanContext(ROOT_CONTEXT, { traceId: parent.traceId, spanId: parent.spanId, traceFlags: parent.sampled === false ? TraceFlags.NONE : TraceFlags.SAMPLED, isRemote: true });
    const startTime = Date.now();
    const monotonicStart = performance.now();
    const native = this.options.tracer.startSpan(name, { attributes: otelAttributes(attributes), startTime }, parentContext);
    const identity = native.spanContext();
    const context = Object.freeze({ traceId: identity.traceId, spanId: identity.spanId, sampled: (identity.traceFlags & TraceFlags.SAMPLED) !== 0 });
    const events: TraceSpanEventData[] = [];
    const start = { name, context, startTime, attributes, ...(parent === undefined ? {} : { parentSpanId: parent.spanId }) };
    this.observe(observer => observer.onStart(start));
    let ended = false;
    return {
      context,
      setAttributes: values => {
        if (ended) return;
        attributes = boundedAttributes({ ...attributes, ...values }, this.limits);
        native.setAttributes(otelAttributes(attributes));
      },
      addEvent: (eventName, values = {}) => {
        if (ended) return;
        if (!eventName || eventName.length > 128) throw new TypeError("Invalid span event name");
        const data = boundedAttributes(values, this.limits);
        const timestamp = Date.now();
        events.push(Object.freeze({ name: eventName, timestamp, attributes: data }));
        if (events.length > this.limits.maxEvents) events.shift();
        native.addEvent(eventName, otelAttributes(data), timestamp);
      },
      end: (end = {}) => {
        if (ended) return;
        if (end.attributes !== undefined) attributes = boundedAttributes({ ...attributes, ...end.attributes }, this.limits);
        ended = true;
        const endTime = Date.now();
        const status = end.status ?? (end.error === undefined ? "ok" : "error");
        native.setAttributes(otelAttributes({ ...attributes, "may.status": status, ...(end.error === undefined ? {} : { "error.type": end.error.name, ...(end.error.code === undefined ? {} : { "error.code": end.error.code }) }) }));
        native.setStatus({ code: status === "error" ? SpanStatusCode.ERROR : status === "ok" ? SpanStatusCode.OK : SpanStatusCode.UNSET });
        native.end(endTime);
        const finished: FinishedTraceSpan = Object.freeze({ ...start, attributes, endTime, durationMs: performance.now() - monotonicStart, status, events: Object.freeze([...events]), ...(end.error === undefined ? {} : { error: end.error }) });
        this.observe(observer => observer.onEnd(finished));
      },
    };
  }
  private observe(callback: (observer: SpanObserver) => void): void {
    for (const observer of this.observers) {
      try { callback(observer); } catch (error) { this.options.onError?.(error); }
    }
  }
}

function otelAttributes(attributes: TraceAttributes): Attributes {
  return Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value])) as Attributes;
}

export interface OtlpTelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion?: string;
  readonly tracesUrl: string;
  readonly metricsUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxQueueSize?: number;
  readonly maxExportBatchSize?: number;
  readonly exportIntervalMs?: number;
  readonly samplingRatio?: number;
  readonly maxMetricSeries?: number;
  readonly observer?: SpanObserver;
  readonly onError?: ObservabilityErrorHandler;
}

export interface OtlpDiagnostics {
  readonly traceExportFailures: number;
  readonly metricExportFailures: number;
  readonly lifecycleFailures: number;
  readonly droppedMetricSeries: number;
  readonly closed: boolean;
}

class ReportingTraceExporter extends OTLPTraceExporter {
  constructor(config: ConstructorParameters<typeof OTLPTraceExporter>[0], private readonly report: (error: unknown) => void) { super(config); }
  override export(spans: Parameters<OTLPTraceExporter["export"]>[0], callback: Parameters<OTLPTraceExporter["export"]>[1]): void {
    super.export(spans, result => {
      if (result.code !== 0) this.report(result.error ?? new Error("OTLP trace export failed"));
      callback(result);
    });
  }
}

class ReportingMetricExporter extends OTLPMetricExporter {
  constructor(config: ConstructorParameters<typeof OTLPMetricExporter>[0], private readonly report: (error: unknown) => void) { super(config); }
  override export(metrics: Parameters<OTLPMetricExporter["export"]>[0], callback: Parameters<OTLPMetricExporter["export"]>[1]): void {
    super.export(metrics, result => {
      if (result.code !== 0) this.report(result.error ?? new Error("OTLP metric export failed"));
      callback(result);
    });
  }
}

export function createOtlpTelemetry(options: OtlpTelemetryOptions): {
  readonly tracer: OpenTelemetryTracer;
  readonly metrics: OpenTelemetryMetricRecorder;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
  getDiagnostics(): OtlpDiagnostics;
} {
  const timeoutMs = positive(options.timeoutMs ?? 5_000);
  const maxQueueSize = positive(options.maxQueueSize ?? 2_048);
  const maxExportBatchSize = positive(options.maxExportBatchSize ?? 256);
  if (maxExportBatchSize > maxQueueSize) throw new RangeError("Batch size exceeds queue limit");
  const ratio = options.samplingRatio ?? 1;
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError("Invalid samplingRatio");
  for (const url of [options.tracesUrl, options.metricsUrl]) if (!["http:", "https:"].includes(new URL(url).protocol)) throw new TypeError("OTLP requires an HTTP URL");
  boundedAttributes({ "service.name": options.serviceName, ...(options.serviceVersion === undefined ? {} : { "service.version": options.serviceVersion }) });
  const resource = resourceFromAttributes({ "service.name": options.serviceName, ...(options.serviceVersion === undefined ? {} : { "service.version": options.serviceVersion }) });
  let traceFailures = 0;
  let metricFailures = 0;
  let lifecycleFailures = 0;
  const report = (error: unknown): void => { try { options.onError?.(error); } catch { /* 保持遥测错误与 Agent 执行独立。 */ } };
  const traceExporter = new ReportingTraceExporter({ url: options.tracesUrl, ...(options.headers === undefined ? {} : { headers: options.headers }), timeoutMillis: timeoutMs, concurrencyLimit: 1 }, error => { traceFailures += 1; report(error); });
  const metricExporter = new ReportingMetricExporter({ url: options.metricsUrl, ...(options.headers === undefined ? {} : { headers: options.headers }), timeoutMillis: timeoutMs, concurrencyLimit: 1 }, error => { metricFailures += 1; report(error); });
  const traceProvider = new BasicTracerProvider({ resource, sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) }), spanProcessors: [new OtelBatchSpanProcessor(traceExporter, { maxQueueSize, maxExportBatchSize, exportTimeoutMillis: timeoutMs })] });
  const metricProvider = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: positive(options.exportIntervalMs ?? 60_000), exportTimeoutMillis: timeoutMs })] });
  const metrics = new OpenTelemetryMetricRecorder(metricProvider.getMeter("@may/observability"), options.maxMetricSeries ?? 1_024);
  const tracer = new OpenTelemetryTracer({ tracer: traceProvider.getTracer("@may/observability"), metrics, ...(options.observer === undefined ? {} : { observer: options.observer }), ...(options.onError === undefined ? {} : { onError: options.onError }) });
  let closed = false;
  const lifecycle = async (action: () => Promise<unknown>): Promise<void> => {
    try { await withTimeout(action(), Math.min(timeoutMs * 2, 2_147_483_647)); } catch (error) { lifecycleFailures += 1; report(error); }
  };
  return {
    tracer, metrics,
    getDiagnostics: () => ({ traceExportFailures: traceFailures, metricExportFailures: metricFailures, lifecycleFailures, droppedMetricSeries: metrics.droppedSeries, closed }),
    forceFlush: () => lifecycle(() => settleOperations([traceProvider.forceFlush(), metricProvider.forceFlush()])),
    shutdown: async () => {
      if (closed) return;
      closed = true;
      await lifecycle(() => settleOperations([traceProvider.shutdown(), metricProvider.shutdown()]));
    },
  };
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new RangeError("Invalid telemetry limit");
  return value;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Telemetry lifecycle timed out")), timeoutMs); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

async function settleOperations(operations: readonly Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(operations);
  const errors = settled.filter((value): value is PromiseRejectedResult => value.status === "rejected").map(value => value.reason);
  if (errors.length > 0) throw new AggregateError(errors, "Telemetry lifecycle failed");
}
