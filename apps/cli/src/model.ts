import type { Model, ModelLimits } from "@may/core";
import {
  DeepSeekModel,
  type DeepSeekModelOptions,
  type DeepSeekReasoningEffort,
} from "@may/provider-deepseek";
import {
  OpenAIResponsesModel,
  type OpenAIReasoningEffort,
  type OpenAIReasoningSummary,
  type OpenAIResponsesModelOptions,
} from "@may/provider-openai";
import { CliConfigError } from "./errors.js";
import type { SelectedModelConfig } from "./selection.js";

const DEEPSEEK_REASONING_EFFORTS = new Set<DeepSeekReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const OPENAI_REASONING_EFFORTS = new Set<OpenAIReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const OPENAI_REASONING_SUMMARIES = new Set<OpenAIReasoningSummary>([
  "auto",
  "concise",
  "detailed",
]);

export function createConfiguredModel(selection: SelectedModelConfig): Model {
  if (selection.provider === "deepseek") return createDeepSeekModel(selection);
  if (selection.provider === "openai") return createOpenAIModel(selection);
  throw new CliConfigError(
    `Unsupported provider "${selection.provider}"; this CLI currently supports deepseek and openai`,
  );
}

function createDeepSeekModel(selection: SelectedModelConfig): Model {
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
    DEEPSEEK_REASONING_EFFORTS,
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    "providers.deepseek.maxTokens",
  ) ?? selection.limits?.maxOutputTokens;

  if (baseURL !== undefined) options.baseURL = baseURL;
  if (thinking !== undefined) options.thinking = thinking;
  if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  return attachLimits(new DeepSeekModel(options), selection.limits);
}

function createOpenAIModel(selection: SelectedModelConfig): Model {
  const baseURL = optionalString(
    selection.providerConfig.baseURL,
    "providers.openai.baseURL",
  );
  const maxOutputTokens = optionalPositiveInteger(
    modelOption(selection, "maxOutputTokens"),
    "providers.openai.maxOutputTokens",
  ) ?? selection.limits?.maxOutputTokens;
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    "providers.openai.reasoningEffort",
    OPENAI_REASONING_EFFORTS,
  );
  const reasoningSummary = optionalEnum(
    tuningOption(selection, "reasoningSummary"),
    "providers.openai.reasoningSummary",
    OPENAI_REASONING_SUMMARIES,
  );
  const serverCompactThreshold = optionalPositiveInteger(
    tuningOption(selection, "serverCompactThreshold"),
    "providers.openai.serverCompactThreshold",
  );
  const store = optionalBoolean(
    tuningOption(selection, "store"),
    "providers.openai.store",
  );
  const options: OpenAIResponsesModelOptions = {
    apiKey: requireString(
      selection.providerConfig.apiKey,
      "providers.openai.apiKey",
    ),
    model: selection.model,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
    ...(serverCompactThreshold === undefined
      ? {}
      : { serverCompactThreshold }),
    ...(store === undefined ? {} : { store }),
  };

  return attachLimits(new OpenAIResponsesModel(options), selection.limits);
}

function attachLimits(model: Model, limits: ModelLimits | undefined): Model {
  if (limits === undefined) return model;
  return {
    limits,
    ...(model.contextCompactor === undefined
      ? {}
      : { contextCompactor: model.contextCompactor }),
    stream: (request, streamOptions) => model.stream(request, streamOptions),
  };
}

function tuningOption(
  selection: SelectedModelConfig,
  name: string,
): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : selection.providerConfig[name];
}

function modelOption(selection: SelectedModelConfig, name: string): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : undefined;
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

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new CliConfigError(`${field} must be a boolean`);
  }
  return value;
}
