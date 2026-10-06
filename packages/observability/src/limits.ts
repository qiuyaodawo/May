import type { TraceAttributes, TraceAttributeValue } from "@may/core";

export interface TelemetryLimits {
  readonly maxAttributes?: number;
  readonly maxStringLength?: number;
  readonly maxArrayLength?: number;
  readonly maxEvents?: number;
}

export const DEFAULT_TELEMETRY_LIMITS = Object.freeze({ maxAttributes: 64, maxStringLength: 256, maxArrayLength: 16, maxEvents: 64 });

export function telemetryLimits(options: TelemetryLimits = {}): Required<TelemetryLimits> {
  const result = { ...DEFAULT_TELEMETRY_LIMITS, ...options };
  for (const [key, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${key} must be a positive integer`);
  }
  return result;
}

export function boundedAttributes(attributes: TraceAttributes, limits: Required<TelemetryLimits> = DEFAULT_TELEMETRY_LIMITS): TraceAttributes {
  const entries = Object.entries(attributes);
  if (entries.length > limits.maxAttributes) throw new RangeError("Telemetry attribute count exceeds limit");
  const result: Record<string, TraceAttributeValue> = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 128 || key.split(".").some(part => ["prompt", "message", "messages", "credential", "credentials", "password", "authorization", "api_key", "apikey", "body", "secret", "input", "output", "reasoning"].includes(part.toLowerCase()))) {
      throw new TypeError("Telemetry attribute key is invalid or contains sensitive content");
    }
    const values = Array.isArray(value) ? value : [value];
    if (values.length > limits.maxArrayLength) throw new RangeError("Telemetry attribute array exceeds limit");
    for (const element of values) {
      if (values.length > 0 && typeof element !== typeof values[0]) throw new TypeError("Telemetry arrays must contain one scalar type");
      if (typeof element !== "string" && typeof element !== "number" && typeof element !== "boolean") throw new TypeError("Invalid telemetry attribute value");
      if (typeof element === "string" && element.length > limits.maxStringLength) throw new RangeError("Telemetry attribute string exceeds limit");
      if (typeof element === "number" && !Number.isFinite(element)) throw new TypeError("Telemetry numbers must be finite");
    }
    result[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(result);
}
