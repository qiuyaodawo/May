import type { MetricRecord, TraceAttributes } from "@may/core";
import type { FinishedTraceSpan, MetricRecorder, SpanObserver, StartedTraceSpan } from "./types.js";
import { boundedAttributes } from "./limits.js";

export interface MetricSnapshot {
  readonly name: string;
  readonly kind: MetricRecord["kind"];
  readonly attributes: TraceAttributes;
  readonly value: number;
  readonly count?: number;
  readonly sum?: number;
  readonly buckets?: readonly { readonly upperBound: number; readonly count: number }[];
}

const LABEL_KEYS = new Set(["may.model.provider", "may.model.adapter", "may.model.name", "may.model.profile", "may.tool.name", "status", "currency", "cost_kind", "cost_complete", "operation", "reason"]);
const BOUNDARIES = [1, 10, 50, 100, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 300_000];

export class BoundedMetrics implements MetricRecorder {
  private readonly series = new Map<string, { record: MetricRecord; value: number; count: number; sum: number; counts: number[] }>();
  readonly maxSeries: number;
  private overflow = 0;
  constructor(options: { maxSeries?: number } = {}) {
    this.maxSeries = options.maxSeries ?? 1_024;
    if (!Number.isSafeInteger(this.maxSeries) || this.maxSeries < 1) throw new RangeError("maxSeries must be a positive integer");
  }
  get droppedSeries(): number { return this.overflow; }
  record(record: MetricRecord): void {
    if (!Number.isFinite(record.value) || !/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(record.name)) throw new TypeError("Invalid metric record");
    if (!["counter", "histogram", "gauge", "updown"].includes(record.kind)) throw new TypeError("Invalid metric kind");
    if ((record.kind === "counter" || record.kind === "histogram") && record.value < 0) throw new RangeError("Metric value cannot be negative");
    const attributes = metricAttributes(record.attributes ?? {});
    const key = JSON.stringify([record.name, record.kind, Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b))]);
    let state = this.series.get(key);
    if (state === undefined) {
      if (this.series.size >= this.maxSeries) { this.overflow += 1; return; }
      state = { record: { ...record, attributes }, value: 0, count: 0, sum: 0, counts: BOUNDARIES.map(() => 0) };
      this.series.set(key, state);
    }
    state.value = record.kind === "gauge" ? record.value : state.value + record.value;
    state.count += 1;
    state.sum += record.value;
    if (record.kind === "histogram") BOUNDARIES.forEach((bound, index) => { if (record.value <= bound) state.counts[index]! += 1; });
  }
  getMetrics(): readonly MetricSnapshot[] {
    return [...this.series.values()].map(({ record, value, count, sum, counts }) => Object.freeze({
      name: record.name, kind: record.kind, attributes: record.attributes ?? {}, value,
      ...(record.kind !== "histogram" ? {} : { count, sum, buckets: Object.freeze(BOUNDARIES.map((upperBound, index) => Object.freeze({ upperBound, count: counts[index]! }))) }),
    }));
  }
}

export function metricAttributes(attributes: TraceAttributes): TraceAttributes {
  return boundedAttributes(Object.fromEntries(Object.entries(attributes).filter(([key]) => LABEL_KEYS.has(key))));
}

export class SpanMetrics implements SpanObserver {
  private readonly activeAttributes = new WeakMap<import("@may/core").TraceContext, TraceAttributes>();
  constructor(private readonly metrics: MetricRecorder) {}
  onStart(span: StartedTraceSpan): void {
    if (operation(span.name)) {
      const attributes = metricAttributes(span.attributes);
      this.activeAttributes.set(span.context, attributes);
      this.metrics.record({ name: `${span.name}.active`, kind: "updown", value: 1, attributes });
    }
  }
  onEnd(span: FinishedTraceSpan): void {
    if (!operation(span.name)) return;
    const attributes = metricAttributes(span.attributes);
    const activeAttributes = this.activeAttributes.get(span.context);
    if (activeAttributes !== undefined) {
      this.metrics.record({ name: `${span.name}.active`, kind: "updown", value: -1, attributes: activeAttributes });
      this.activeAttributes.delete(span.context);
    }
    this.metrics.record({ name: `${span.name}.count`, kind: "counter", value: 1, attributes: { ...attributes, status: span.status } });
    this.metrics.record({ name: `${span.name}.duration`, kind: "histogram", value: span.durationMs, unit: "ms", attributes });
    if (span.name === "may.model.call") {
      for (const key of ["first_content_ms", "first_text_ms"]) {
        const value = span.attributes[`may.model.${key}`];
        if (typeof value === "number") this.metrics.record({ name: `may.model.${key}`, kind: "histogram", value, unit: "ms", attributes });
      }
      const retries = Math.max(0, Number(span.attributes["may.model.attempts"] ?? 1) - 1);
      this.metrics.record({ name: "may.model.retries", kind: "counter", value: retries, attributes });
      const retryWaitMs = span.attributes["may.model.retry_wait_ms"];
      if (typeof retryWaitMs === "number") this.metrics.record({ name: "may.model.retry_wait", kind: "histogram", value: retryWaitMs, unit: "ms", attributes });
      if (span.attributes["may.model.usage_available"] === false) this.metrics.record({ name: "may.model.usage_missing", kind: "counter", value: 1, attributes });
      for (const field of ["input_tokens", "output_tokens", "total_tokens", "cached_read_tokens", "cached_write_tokens", "reasoning_tokens"]) {
        const value = span.attributes[`may.model.${field}`];
        if (typeof value === "number") this.metrics.record({ name: `may.model.${field}`, kind: "counter", value, attributes });
      }
      const cost = span.attributes["may.model.cost"];
      if (typeof cost === "number") this.metrics.record({ name: "may.model.cost", kind: "counter", value: cost, attributes: {
        ...attributes, currency: String(span.attributes["may.model.currency"] ?? "USD"),
        ...(span.attributes["may.model.cost_kind"] === undefined ? {} : { cost_kind: span.attributes["may.model.cost_kind"] }),
        ...(span.attributes["may.model.cost_complete"] === undefined ? {} : { cost_complete: span.attributes["may.model.cost_complete"] }),
      } });
      if (span.attributes["may.model.cost_complete"] === false) this.metrics.record({ name: "may.model.cost_missing", kind: "counter", value: 1, attributes });
    }
  }
}

function operation(name: string): boolean {
  return ["may.run", "may.model.call", "may.model.attempt", "may.tool.call", "may.permission.check", "may.permission.approval_wait", "may.task.queue"].includes(name);
}
