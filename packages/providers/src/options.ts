import type { Model, ModelLimits } from "@may/core";

import { ProviderConfigurationError } from "./errors.js";
import type { ProviderModelSelection } from "./types.js";

export function providerField(
  selection: ProviderModelSelection,
  name: string,
): string {
  return `providers.${selection.provider}.${name}`;
}

export function tuningOption(
  selection: ProviderModelSelection,
  name: string,
): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : selection.providerConfig[name];
}

export function modelOption(
  selection: ProviderModelSelection,
  name: string,
): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : undefined;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProviderConfigurationError(
      `${field} must be a non-empty string`,
    );
  }
  return value;
}

export function optionalString(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

export function optionalEnum<const Value extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<Value>,
): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.has(value as Value)) {
    throw new ProviderConfigurationError(
      `${field} must be one of: ${[...allowed].join(", ")}`,
    );
  }
  return value as Value;
}

export function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new ProviderConfigurationError(
      `${field} must be a positive safe integer`,
    );
  }
  return value as number;
}

export function optionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new ProviderConfigurationError(`${field} must be a boolean`);
  }
  return value;
}

export function requireRecord(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderConfigurationError(`${field} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export function attachModelLimits(
  model: Model,
  limits: ModelLimits | undefined,
  maxOutputTokens?: number,
): Model {
  const effectiveLimits = mergeLimits(limits, maxOutputTokens);
  if (effectiveLimits === undefined) return model;
  return {
    limits: effectiveLimits,
    ...(model.contextCompactor === undefined
      ? {}
      : { contextCompactor: model.contextCompactor }),
    stream: (request, streamOptions) => model.stream(request, streamOptions),
  };
}

function mergeLimits(
  limits: ModelLimits | undefined,
  maxOutputTokens: number | undefined,
): ModelLimits | undefined {
  if (limits === undefined && maxOutputTokens === undefined) return undefined;
  const effectiveOutputTokens = maxOutputTokens ?? limits?.maxOutputTokens;
  return {
    ...(limits?.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: limits.contextWindowTokens }),
    ...(effectiveOutputTokens === undefined
      ? {}
      : { maxOutputTokens: effectiveOutputTokens }),
  };
}
