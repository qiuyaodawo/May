import type { TraceAttributes, TraceContext } from "./tracing.js";

export interface TelemetryCorrelation {
  readonly version: 1;
  readonly taskId?: string;
  readonly coordinationId?: string;
  readonly dispatchId?: string;
  readonly schedulerExecutionId?: string;
  readonly resumedFromRunId?: string;
  readonly parent?: TraceContext;
}

/** 跨进程只传递经过验证的身份；禁止附带消息、参数和凭据。 */
export function validateTelemetryCorrelation(value: unknown): TelemetryCorrelation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid telemetry correlation");
  const input = value as Record<string, unknown>;
  const keys = ["taskId", "coordinationId", "dispatchId", "schedulerExecutionId", "resumedFromRunId"] as const;
  if (input.version !== 1 || Object.keys(input).some(key => key !== "version" && key !== "parent" && !keys.includes(key as typeof keys[number]))) {
    throw new TypeError("Unsupported telemetry correlation format");
  }
  for (const key of keys) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || input[key].length === 0 || input[key].length > 256 || /[\u0000-\u001f\u007f]/u.test(input[key]))) {
      throw new TypeError(`Invalid telemetry correlation ${key}`);
    }
  }
  if (input.parent !== undefined) {
    if (!input.parent || typeof input.parent !== "object" || Array.isArray(input.parent)) throw new TypeError("Invalid telemetry parent");
    const parent = input.parent as Record<string, unknown>;
    if (Object.keys(parent).some(key => !["traceId", "spanId", "sampled"].includes(key)) ||
      typeof parent.traceId !== "string" || !/^[a-f0-9]{32}$/u.test(parent.traceId) || /^0+$/u.test(parent.traceId) ||
      typeof parent.spanId !== "string" || !/^[a-f0-9]{16}$/u.test(parent.spanId) || /^0+$/u.test(parent.spanId) ||
      (parent.sampled !== undefined && typeof parent.sampled !== "boolean")) throw new TypeError("Invalid telemetry parent identity");
  }
  return Object.freeze({ ...input, ...(input.parent === undefined ? {} : { parent: Object.freeze({ ...input.parent as TraceContext }) }) }) as unknown as TelemetryCorrelation;
}

export function correlationTraceAttributes(value: TelemetryCorrelation): TraceAttributes {
  const correlation = validateTelemetryCorrelation(value);
  return {
    "may.correlation.version": 1,
    ...(correlation.taskId === undefined ? {} : { "may.task.id": correlation.taskId }),
    ...(correlation.coordinationId === undefined ? {} : { "may.coordination.id": correlation.coordinationId }),
    ...(correlation.dispatchId === undefined ? {} : { "may.dispatch.id": correlation.dispatchId }),
    ...(correlation.schedulerExecutionId === undefined ? {} : { "may.scheduler.execution_id": correlation.schedulerExecutionId }),
    ...(correlation.resumedFromRunId === undefined ? {} : { "may.run.resumed_from": correlation.resumedFromRunId }),
  };
}
