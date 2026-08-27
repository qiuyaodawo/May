import { CodingToolError } from "./errors.js";

export function requireObject(
  value: unknown,
  toolName: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(toolName, "input must be an object");
  }
  return value as Record<string, unknown>;
}

export function requireString(
  value: unknown,
  toolName: string,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.trim() === "")
  ) {
    const suffix = options.allowEmpty ? "a string" : "a non-empty string";
    throw invalidInput(toolName, `${field} must be ${suffix}`);
  }
  return value;
}

export function optionalPositiveInteger(
  value: unknown,
  toolName: string,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidInput(toolName, `${field} must be a positive safe integer`);
  }
  return value as number;
}

export function requirePositiveIntegerOption(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
  return resolved;
}

function invalidInput(toolName: string, message: string): CodingToolError {
  return new CodingToolError(
    "CODING_TOOL_INVALID_INPUT",
    `${toolName}: ${message}`,
  );
}
