/** Scalar values that are safe to attach to operational telemetry.
 * @experimental
 */
export type TraceAttributeValue =
  string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/** @experimental */
export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>;

/** Propagated identity for one trace and its current parent span.
 * @experimental
 */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled?: boolean;
}

/** @experimental */
export interface TraceError {
  readonly name: string;
  readonly code?: string;
}

/** @experimental */
export type TraceSpanStatus = "ok" | "error" | "cancelled";

/** @experimental */
export interface TraceSpanStartOptions {
  readonly parent?: TraceContext;
  readonly attributes?: TraceAttributes;
}

/** @experimental */
export interface TraceSpanEndOptions {
  readonly status?: TraceSpanStatus;
  readonly attributes?: TraceAttributes;
  readonly error?: TraceError;
}

/** A synchronous, fail-open instrumentation handle.
 * @experimental
 */
export interface TraceSpan {
  readonly context: TraceContext;
  setAttributes(attributes: TraceAttributes): void;
  addEvent(name: string, attributes?: TraceAttributes): void;
  end(options?: TraceSpanEndOptions): void;
}

/**
 * Minimal tracing port owned by Core. Implementations belong in optional
 * packages and must not make Agent execution depend on telemetry delivery.
 * @experimental
 */
export interface Tracer {
  startSpan(name: string, options?: TraceSpanStartOptions): TraceSpan;
  recordMetric?(record: MetricRecord): void;
}

/** @experimental */
export interface MetricRecord {
  readonly name: string;
  readonly kind: "counter" | "histogram" | "gauge" | "updown";
  readonly value: number;
  readonly attributes?: TraceAttributes;
  readonly unit?: string;
}

/** @experimental */
export function recordMetric(tracer: Tracer | undefined, record: MetricRecord): void {
  failOpen(() => tracer?.recordMetric?.(record));
}

/** Start a span without allowing a third-party tracer failure to affect May.
 * @experimental
 */
export function startTraceSpan(
  tracer: Tracer | undefined,
  name: string,
  options?: TraceSpanStartOptions,
): TraceSpan | undefined {
  if (tracer === undefined) return undefined;
  return failOpenValue(() => protectSpan(tracer.startSpan(name, options)), undefined);
}

/** Set attributes without putting telemetry on the execution failure path.
 * @experimental
 */
export function setTraceAttributes(span: TraceSpan | undefined, attributes: TraceAttributes): void {
  failOpen(() => span?.setAttributes(attributes));
}

/** Add an instantaneous span event without affecting Agent execution.
 * @experimental
 */
export function addTraceEvent(span: TraceSpan | undefined, name: string, attributes?: TraceAttributes): void {
  failOpen(() => span?.addEvent(name, attributes));
}

/** End a span without allowing exporter or processor failures to escape.
 * @experimental
 */
export function endTraceSpan(span: TraceSpan | undefined, options?: TraceSpanEndOptions): void {
  failOpen(() => span?.end(options));
}

/** Convert an arbitrary failure into content-free trace error metadata.
 * @experimental
 */
export function traceError(error: unknown): TraceError {
  if (!(error instanceof Error)) return { name: "Error" };
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code === undefined ? { name: error.name } : { name: error.name, code };
}

function protectSpan(span: TraceSpan): TraceSpan {
  const context = failOpenValue(() => span.context, undefined);
  if (context === undefined) return inertSpan();

  return {
    context,
    setAttributes(attributes) {
      failOpen(() => span.setAttributes(attributes));
    },
    addEvent(name, attributes) {
      failOpen(() => span.addEvent(name, attributes));
    },
    end(options) {
      failOpen(() => span.end(options));
    },
  };
}

function failOpen(action: () => void): void {
  try {
    action();
  } catch {
    // Observability is deliberately fail-open; failures are reported via component diagnostics.
    return;
  }
}

function failOpenValue<T>(action: () => T, fallback: T): T {
  try {
    return action();
  } catch {
    return fallback;
  }
}

function inertSpan(): TraceSpan {
  return {
    context: { traceId: "", spanId: "", sampled: false },
    setAttributes() {},
    addEvent() {},
    end() {},
  };
}
