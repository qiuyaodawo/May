import type { Model } from "@may/core";
import {
  DeepSeekModel,
  type DeepSeekModelOptions,
  type DeepSeekReasoningEffort,
} from "@may/provider-deepseek";
import { CliConfigError } from "./errors.js";
import type { SelectedModelConfig } from "./selection.js";

const REASONING_EFFORTS = new Set<DeepSeekReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export function createConfiguredModel(selection: SelectedModelConfig): Model {
  if (selection.provider !== "deepseek") {
    throw new CliConfigError(
      `Unsupported provider "${selection.provider}"; this CLI currently supports deepseek`,
    );
  }

  const options: DeepSeekModelOptions = {
    apiKey: requireString(
      selection.providerConfig.apiKey,
      "providers.deepseek.apiKey",
    ),
    model: selection.model,
  };
  const baseURL = optionalString(
    selection.providerConfig.baseURL,
    "providers.deepseek.baseURL",
  );
  const thinking = optionalEnum(
    tuningOption(selection, "thinking"),
    "providers.deepseek.thinking",
    new Set(["enabled", "disabled"] as const),
  );
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    "providers.deepseek.reasoningEffort",
    REASONING_EFFORTS,
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    "providers.deepseek.maxTokens",
  );

  if (baseURL !== undefined) options.baseURL = baseURL;
  if (thinking !== undefined) options.thinking = thinking;
  if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  return new DeepSeekModel(options);
}

function tuningOption(
  selection: SelectedModelConfig,
  name: string,
): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : selection.providerConfig[name];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CliConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function optionalEnum<const Value extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<Value>,
): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.has(value as Value)) {
    throw new CliConfigError(
      `${field} must be one of: ${[...allowed].join(", ")}`,
    );
  }
  return value as Value;
}

function optionalPositiveInteger(
  value: unknown,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new CliConfigError(`${field} must be a positive safe integer`);
  }
  return value as number;
}
