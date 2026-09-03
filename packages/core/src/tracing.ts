/** Scalar values that are safe to attach to operational telemetry. */
export type TraceAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type TraceAttributes = Readonly<Record<string, TraceAttributeValue>>;

/** Propagated identity for one trace and its current parent span. */
export interface TraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled?: boolean;
}

export interface TraceError {
  readonly name: string;
  readonly code?: string;
}

export type TraceSpanStatus = "ok" | "error" | "cancelled";

export interface TraceSpanStartOptions {
  readonly parent?: TraceContext;
  readonly attributes?: TraceAttributes;
}

export interface TraceSpanEndOptions {
  readonly status?: TraceSpanStatus;
  readonly attributes?: TraceAttributes;
  readonly error?: TraceError;
}

/** A synchronous, fail-open instrumentation handle. */
export interface TraceSpan {
  readonly context: TraceContext;
  setAttributes(attributes: TraceAttributes): void;
  addEvent(name: string, attributes?: TraceAttributes): void;
  end(options?: TraceSpanEndOptions): void;
}

/**
 * Minimal tracing port owned by Core. Implementations belong in optional
 * packages and must not make Agent execution depend on telemetry delivery.
 */
export interface Tracer {
  startSpan(name: string, options?: TraceSpanStartOptions): TraceSpan;
}

/** Start a span without allowing a third-party tracer failure to affect May. */
export function startTraceSpan(
  tracer: Tracer | undefined,
  name: string,
  options?: TraceSpanStartOptions,
): TraceSpan | undefined {
  if (tracer === undefined) return undefined;
  try {
    return protectSpan(tracer.startSpan(name, options));
  } catch {
    return undefined;
  }
}

/** Set attributes without putting telemetry on the execution failure path. */
export function setTraceAttributes(
  span: TraceSpan | undefined,
  attributes: TraceAttributes,
): void {
  try {
    span?.setAttributes(attributes);
  } catch {
    // Observability is deliberately fail-open.
  }
}

/** Add an instantaneous span event without affecting Agent execution. */
export function addTraceEvent(
  span: TraceSpan | undefined,
  name: string,
  attributes?: TraceAttributes,
): void {
  try {
    span?.addEvent(name, attributes);
  } catch {
    // Observability is deliberately fail-open.
  }
}

/** End a span without allowing exporter or processor failures to escape. */
export function endTraceSpan(
  span: TraceSpan | undefined,
  options?: TraceSpanEndOptions,
): void {
  try {
    span?.end(options);
  } catch {
    // Observability is deliberately fail-open.
  }
}

/** Convert an arbitrary failure into content-free trace error metadata. */
export function traceError(error: unknown): TraceError {
  if (!(error instanceof Error)) return { name: "Error" };
  const code = "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  return code === undefined ? { name: error.name } : { name: error.name, code };
}

function protectSpan(span: TraceSpan): TraceSpan {
  let context: TraceContext;
  try {
    context = span.context;
  } catch {
    return inertSpan();
  }

  return {
    context,
    setAttributes(attributes) {
      try {
        span.setAttributes(attributes);
      } catch {
        // Observability is deliberately fail-open.
      }
    },
    addEvent(name, attributes) {
      try {
        span.addEvent(name, attributes);
      } catch {
        // Observability is deliberately fail-open.
      }
    },
    end(options) {
      try {
        span.end(options);
      } catch {
        // Observability is deliberately fail-open.
      }
    },
  };
}

function inertSpan(): TraceSpan {
  return {
    context: { traceId: "", spanId: "", sampled: false },
    setAttributes() {},
    addEvent() {},
    end() {},
  };
}
