export const detailFields = [
  ["cachedReadTokens", "cachedRead", "cachedReadPerMillion"],
  ["cachedWriteTokens", "cachedWrite", "cachedWritePerMillion"],
  ["reasoningTokens", "reasoning", "reasoningPerMillion"],
] as const;

export function object(value: unknown, field: string): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${field} must be an object`);
}

export function nonnegative(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new RangeError(`${field} must be finite and non-negative`);
}

export function boundedText(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256)
    throw new TypeError(`${field} must be a non-empty string of at most 256 characters`);
}

export function currency(value: unknown): void {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value))
    throw new TypeError("Currency must be an uppercase ISO 4217 code");
}
