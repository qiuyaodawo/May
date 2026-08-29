import {
  resolveModelProfile,
  resolveProviderConfig,
  type MayConfig,
  type ProviderConfig,
} from "@may/config";
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

import { MaybeCodeConfigError } from "./errors.js";

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

export interface MaybeCodeModelSelector {
  readonly provider?: string;
  readonly model?: string;
}

export interface SelectedMaybeCodeModel {
  readonly provider: string;
  readonly model: string;
  readonly providerConfig: ProviderConfig;
  readonly options: Readonly<Record<string, unknown>>;
  readonly limits?: ModelLimits;
}

export function selectMaybeCodeModel(
  config: MayConfig,
  selector: MaybeCodeModelSelector = {},
): SelectedMaybeCodeModel {
  if (selector.provider !== undefined && selector.model !== undefined) {
    throw new MaybeCodeConfigError(
      "A provider and model profile cannot be selected together",
    );
  }

  if (
    selector.model !== undefined ||
    (selector.provider === undefined && config.defaultModel !== undefined)
  ) {
    const profile = resolveModelProfile(config, selector.model);
    return {
      provider: profile.provider,
      model: profile.model,
      providerConfig: profile.providerConfig,
      options: profile.options,
      ...modelLimits(profile.contextWindowTokens, profile.maxOutputTokens),
    };
  }

  const provider = selector.provider ?? onlyProvider(config);
  const providerConfig = resolveProviderConfig(config, provider);
  const model = providerConfig.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new MaybeCodeConfigError(
      `Set providers.${provider}.model in ${config.path}`,
    );
  }
  return {
    provider,
    model,
    providerConfig,
    options: {},
    ...modelLimits(
      providerConfig.contextWindowTokens,
      providerConfig.maxOutputTokens,
    ),
  };
}

export function createMaybeCodeModel(
  selection: SelectedMaybeCodeModel,
): Model {
  if (selection.provider === "deepseek") return createDeepSeekModel(selection);
  if (selection.provider === "openai") return createOpenAIModel(selection);
  throw new MaybeCodeConfigError(
    `Unsupported provider "${selection.provider}"; MaybeCode currently supports deepseek and openai`,
  );
}

function createDeepSeekModel(selection: SelectedMaybeCodeModel): Model {
  const options: DeepSeekModelOptions = {
    apiKey: requiredString(
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
  );

  if (baseURL !== undefined) options.baseURL = baseURL;
  if (thinking !== undefined) options.thinking = thinking;
  if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
  if (maxTokens !== undefined) options.maxTokens = maxTokens;
  const model = new DeepSeekModel(options);
  const limits = modelLimits(
    selection.limits?.contextWindowTokens,
    maxTokens ?? selection.limits?.maxOutputTokens,
  ).limits;
  return attachLimits(model, limits);
}

function createOpenAIModel(selection: SelectedMaybeCodeModel): Model {
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
    apiKey: requiredString(
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

  const model = new OpenAIResponsesModel(options);
  const limits = modelLimits(
    selection.limits?.contextWindowTokens,
    maxOutputTokens,
  ).limits;
  return attachLimits(model, limits);
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

function modelLimits(
  contextWindowTokens: number | undefined,
  maxOutputTokens: number | undefined,
): { limits?: ModelLimits } {
  if (contextWindowTokens === undefined && maxOutputTokens === undefined) {
    return {};
  }
  return {
    limits: {
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  };
}

function onlyProvider(config: MayConfig): string {
  const providers = Object.keys(config.providers);
  if (providers.length === 0) {
    throw new MaybeCodeConfigError(`No providers are configured in ${config.path}`);
  }
  if (providers.length > 1) {
    throw new MaybeCodeConfigError(
      "Select a provider with --provider or configure defaultModel",
    );
  }
  return providers[0]!;
}

function tuningOption(
  selection: SelectedMaybeCodeModel,
  name: string,
): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : selection.providerConfig[name];
}

function modelOption(
  selection: SelectedMaybeCodeModel,
  name: string,
): unknown {
  return Object.hasOwn(selection.options, name)
    ? selection.options[name]
    : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MaybeCodeConfigError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function optionalEnum<const Value extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<Value>,
): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.has(value as Value)) {
    throw new MaybeCodeConfigError(
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
    throw new MaybeCodeConfigError(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new MaybeCodeConfigError(`${field} must be a boolean`);
  }
  return value;
}
