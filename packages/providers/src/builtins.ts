import {
  AnthropicModel,
  type AnthropicModelOptions,
  type AnthropicReasoningEffort,
  type AnthropicThinkingConfig,
} from "@may/provider-anthropic";
import {
  DeepSeekModel,
  type DeepSeekModelOptions,
  type DeepSeekReasoningEffort,
} from "@may/provider-deepseek";
import {
  KimiModel,
  type KimiModelOptions,
  type KimiReasoningEffort,
  type KimiThinkingConfig,
} from "@may/provider-kimi";
import {
  OpenAIResponsesModel,
  type OpenAIReasoningEffort,
  type OpenAIReasoningSummary,
  type OpenAIResponsesModelOptions,
} from "@may/provider-openai";
import {
  ZhipuModel,
  type ZhipuModelOptions,
  type ZhipuReasoningEffort,
} from "@may/provider-zhipu";
import type { Model } from "@may/core";

import { ProviderConfigurationError } from "./errors.js";
import {
  attachModelLimits,
  modelOption,
  optionalBoolean,
  optionalEnum,
  optionalPositiveInteger,
  optionalString,
  providerField,
  requiredString,
  requireRecord,
  tuningOption,
} from "./options.js";
import { ProviderRegistry } from "./registry.js";
import type { ProviderFactory, ProviderModelSelection } from "./types.js";

const DEEPSEEK_REASONING_EFFORTS = new Set<DeepSeekReasoningEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ZHIPU_REASONING_EFFORTS = new Set<ZhipuReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const KIMI_REASONING_EFFORTS = new Set<KimiReasoningEffort>([
  "low",
  "high",
  "max",
]);
const ANTHROPIC_REASONING_EFFORTS = new Set<AnthropicReasoningEffort>([
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
const THINKING_TYPES = new Set(["enabled", "disabled"] as const);
const ANTHROPIC_THINKING_TYPES = new Set([
  "enabled",
  "adaptive",
  "disabled",
] as const);
const THINKING_DISPLAYS = new Set(["summarized", "omitted"] as const);

export interface BuiltinProviderRegistryOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export function createBuiltinProviderRegistry(
  options: BuiltinProviderRegistryOptions = {},
): ProviderRegistry {
  const registry = new ProviderRegistry();
  const zhipu = factory((selection) => createZhipuModel(selection, options));
  registry
    .register("deepseek", factory((selection) =>
      createDeepSeekModel(selection, options)
    ))
    .register("zhipu", zhipu)
    .register("glm", zhipu)
    .register("kimi", factory((selection) => createKimiModel(selection, options)))
    .register("anthropic", factory((selection) =>
      createAnthropicModel(selection, options)
    ))
    .register("openai", factory((selection) =>
      createOpenAIModel(selection, options)
    ));
  return registry;
}

export function createBuiltinProviderModel(
  selection: ProviderModelSelection,
  options: BuiltinProviderRegistryOptions = {},
): Model {
  return createBuiltinProviderRegistry(options).create(selection);
}

function createDeepSeekModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderRegistryOptions,
): Model {
  const thinking = optionalEnum(
    tuningOption(selection, "thinking"),
    providerField(selection, "thinking"),
    THINKING_TYPES,
  );
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    providerField(selection, "reasoningEffort"),
    DEEPSEEK_REASONING_EFFORTS,
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    providerField(selection, "maxTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const baseURL = providerBaseURL(selection);
  const options: DeepSeekModelOptions = {
    ...credentials(selection),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
  return attachModelLimits(
    new DeepSeekModel(options),
    selection.limits,
    maxTokens,
  );
}

function createZhipuModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderRegistryOptions,
): Model {
  const thinking = optionalEnum(
    tuningOption(selection, "thinking"),
    providerField(selection, "thinking"),
    THINKING_TYPES,
  );
  const clearThinking = optionalBoolean(
    tuningOption(selection, "clearThinking"),
    providerField(selection, "clearThinking"),
  );
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    providerField(selection, "reasoningEffort"),
    ZHIPU_REASONING_EFFORTS,
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    providerField(selection, "maxTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const baseURL = providerBaseURL(selection);
  const options: ZhipuModelOptions = {
    ...credentials(selection),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(clearThinking === undefined ? {} : { clearThinking }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
  return attachModelLimits(new ZhipuModel(options), selection.limits, maxTokens);
}

function createKimiModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderRegistryOptions,
): Model {
  const thinking = optionalKimiThinking(
    tuningOption(selection, "thinking"),
    providerField(selection, "thinking"),
  );
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    providerField(selection, "reasoningEffort"),
    KIMI_REASONING_EFFORTS,
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    providerField(selection, "maxTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const baseURL = providerBaseURL(selection);
  const options: KimiModelOptions = {
    ...credentials(selection),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
  return attachModelLimits(new KimiModel(options), selection.limits, maxTokens);
}

function createAnthropicModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderRegistryOptions,
): Model {
  const thinking = optionalAnthropicThinking(
    tuningOption(selection, "thinking"),
    providerField(selection, "thinking"),
  );
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    providerField(selection, "reasoningEffort"),
    ANTHROPIC_REASONING_EFFORTS,
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    providerField(selection, "maxTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const baseURL = providerBaseURL(selection);
  const apiVersion = optionalString(
    tuningOption(selection, "apiVersion"),
    providerField(selection, "apiVersion"),
  );
  const options: AnthropicModelOptions = {
    ...credentials(selection),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(thinking === undefined ? {} : { thinking }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
  return attachModelLimits(
    new AnthropicModel(options),
    selection.limits,
    maxTokens,
  );
}

function createOpenAIModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderRegistryOptions,
): Model {
  const maxOutputTokens = optionalPositiveInteger(
    modelOption(selection, "maxOutputTokens"),
    providerField(selection, "maxOutputTokens"),
  ) ?? selection.limits?.maxOutputTokens ?? optionalPositiveInteger(
    selection.providerConfig.maxOutputTokens,
    providerField(selection, "maxOutputTokens"),
  );
  const reasoningEffort = optionalEnum(
    tuningOption(selection, "reasoningEffort"),
    providerField(selection, "reasoningEffort"),
    OPENAI_REASONING_EFFORTS,
  );
  const reasoningSummary = optionalEnum(
    tuningOption(selection, "reasoningSummary"),
    providerField(selection, "reasoningSummary"),
    OPENAI_REASONING_SUMMARIES,
  );
  const serverCompactThreshold = optionalPositiveInteger(
    tuningOption(selection, "serverCompactThreshold"),
    providerField(selection, "serverCompactThreshold"),
  );
  const store = optionalBoolean(
    tuningOption(selection, "store"),
    providerField(selection, "store"),
  );
  const baseURL = providerBaseURL(selection);
  const options: OpenAIResponsesModelOptions = {
    ...credentials(selection),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
    ...(serverCompactThreshold === undefined
      ? {}
      : { serverCompactThreshold }),
    ...(store === undefined ? {} : { store }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
  return attachModelLimits(
    new OpenAIResponsesModel(options),
    selection.limits,
    maxOutputTokens,
  );
}

function credentials(selection: ProviderModelSelection): {
  apiKey: string;
  model: string;
} {
  return {
    apiKey: requiredString(
      selection.providerConfig.apiKey,
      providerField(selection, "apiKey"),
    ),
    model: requiredString(selection.model, "model"),
  };
}

function providerBaseURL(
  selection: ProviderModelSelection,
): string | undefined {
  return optionalString(
    selection.providerConfig.baseURL,
    providerField(selection, "baseURL"),
  );
}

function optionalKimiThinking(
  value: unknown,
  field: string,
): KimiThinkingConfig | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, field);
  const type = optionalEnum(record.type, `${field}.type`, THINKING_TYPES);
  if (type === undefined) {
    throw new ProviderConfigurationError(`${field}.type is required`);
  }
  const keep = record.keep;
  if (keep !== undefined && keep !== "all" && keep !== null) {
    throw new ProviderConfigurationError(
      `${field}.keep must be "all" or null`,
    );
  }
  return {
    type,
    ...(keep === undefined ? {} : { keep }),
  };
}

function optionalAnthropicThinking(
  value: unknown,
  field: string,
): AnthropicThinkingConfig | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, field);
  const type = optionalEnum(
    record.type,
    `${field}.type`,
    ANTHROPIC_THINKING_TYPES,
  );
  if (type === undefined) {
    throw new ProviderConfigurationError(`${field}.type is required`);
  }
  const display = optionalEnum(
    record.display,
    `${field}.display`,
    THINKING_DISPLAYS,
  );
  if (type === "enabled") {
    const budgetTokens = optionalPositiveInteger(
      record.budgetTokens,
      `${field}.budgetTokens`,
    );
    if (budgetTokens === undefined) {
      throw new ProviderConfigurationError(
        `${field}.budgetTokens is required when thinking is enabled`,
      );
    }
    return {
      type,
      budgetTokens,
      ...(display === undefined ? {} : { display }),
    };
  }
  return {
    type,
    ...(display === undefined || type === "disabled" ? {} : { display }),
  };
}

function factory(
  create: (selection: ProviderModelSelection) => Model,
): ProviderFactory {
  return { create };
}
