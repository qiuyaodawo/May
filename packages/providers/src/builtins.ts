import {
  AnthropicModel,
  type AnthropicModelOptions,
  type AnthropicThinkingConfig,
} from "@may/provider-anthropic";
import {
  DeepSeekModel,
  type DeepSeekModelOptions,
} from "@may/provider-deepseek";
import {
  KimiModel,
  type KimiModelOptions,
  type KimiThinkingConfig,
} from "@may/provider-kimi";
import {
  OpenAIResponsesModel,
  type OpenAIReasoningSummary,
  type OpenAIResponsesModelOptions,
} from "@may/provider-openai";
import {
  OpenAIChatCompletionsModel,
  type OpenAIChatCompletionsModelOptions,
} from "@may/provider-openai-compatible";
import {
  ZhipuModel,
  type ZhipuModelOptions,
} from "@may/provider-zhipu";
import type { Model } from "@may/core";

import { ProviderConfigurationError } from "./errors.js";
import {
  attachModelLimits,
  modelOption,
  optionField,
  optionalBoolean,
  optionalEnum,
  optionalPositiveInteger,
  optionalString,
  providerField,
  requiredString,
  requireRecord,
  tuningOption,
} from "./options.js";
import { ProviderAdapterRegistry } from "./registry.js";
import type {
  ProviderAdapterFactory,
  ProviderModelSelection,
} from "./types.js";

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

export interface BuiltinProviderAdapterRegistryOptions {
  readonly fetch?: typeof globalThis.fetch;
}

export function createBuiltinProviderAdapterRegistry(
  options: BuiltinProviderAdapterRegistryOptions = {},
): ProviderAdapterRegistry {
  const registry = new ProviderAdapterRegistry();
  const zhipu = factory((selection) => createZhipuModel(selection, options));
  registry
    .register("deepseek-chat", factory((selection) =>
      createDeepSeekModel(selection, options)
    ))
    .register("zhipu-chat", zhipu)
    .register("kimi-chat", factory((selection) =>
      createKimiModel(selection, options)
    ))
    .register("anthropic-messages", factory((selection) =>
      createAnthropicModel(selection, options)
    ))
    .register("openai-responses", factory((selection) =>
      createOpenAIModel(selection, options)
    ))
    .register("openai-chat-completions", factory((selection) =>
      createOpenAIChatCompletionsModel(selection, options)
    ));
  return registry;
}

export function createBuiltinProviderModel(
  selection: ProviderModelSelection,
  options: BuiltinProviderAdapterRegistryOptions = {},
): Model {
  return createBuiltinProviderAdapterRegistry(options).create(selection);
}

function createDeepSeekModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderAdapterRegistryOptions,
): Model {
  const thinking = optionalEnum(
    tuningOption(selection, "thinking"),
    optionField(selection, "thinking"),
    THINKING_TYPES,
  );
  const reasoningEffort = optionalString(
    tuningOption(selection, "reasoningEffort"),
    optionField(selection, "reasoningEffort"),
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    optionField(selection, "maxTokens"),
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
  dependencies: BuiltinProviderAdapterRegistryOptions,
): Model {
  const thinking = optionalEnum(
    tuningOption(selection, "thinking"),
    optionField(selection, "thinking"),
    THINKING_TYPES,
  );
  const clearThinking = optionalBoolean(
    tuningOption(selection, "clearThinking"),
    optionField(selection, "clearThinking"),
  );
  const reasoningEffort = optionalString(
    tuningOption(selection, "reasoningEffort"),
    optionField(selection, "reasoningEffort"),
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    optionField(selection, "maxTokens"),
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
  dependencies: BuiltinProviderAdapterRegistryOptions,
): Model {
  const thinking = optionalKimiThinking(
    tuningOption(selection, "thinking"),
    optionField(selection, "thinking"),
  );
  const reasoningEffort = optionalString(
    tuningOption(selection, "reasoningEffort"),
    optionField(selection, "reasoningEffort"),
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    optionField(selection, "maxTokens"),
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
  dependencies: BuiltinProviderAdapterRegistryOptions,
): Model {
  const thinking = optionalAnthropicThinking(
    tuningOption(selection, "thinking"),
    optionField(selection, "thinking"),
  );
  const reasoningEffort = optionalString(
    tuningOption(selection, "reasoningEffort"),
    optionField(selection, "reasoningEffort"),
  );
  const maxTokens = optionalPositiveInteger(
    tuningOption(selection, "maxTokens"),
    optionField(selection, "maxTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const baseURL = providerBaseURL(selection);
  const apiVersion = optionalString(
    tuningOption(selection, "apiVersion"),
    optionField(selection, "apiVersion"),
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
  dependencies: BuiltinProviderAdapterRegistryOptions,
): Model {
  const maxOutputTokens = optionalPositiveInteger(
    modelOption(selection, "maxOutputTokens"),
    optionField(selection, "maxOutputTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const reasoningEffort = optionalString(
    tuningOption(selection, "reasoningEffort"),
    optionField(selection, "reasoningEffort"),
  );
  const reasoningSummary = optionalEnum(
    tuningOption(selection, "reasoningSummary"),
    optionField(selection, "reasoningSummary"),
    OPENAI_REASONING_SUMMARIES,
  );
  const serverCompactThreshold = optionalPositiveInteger(
    tuningOption(selection, "serverCompactThreshold"),
    optionField(selection, "serverCompactThreshold"),
  );
  const store = optionalBoolean(
    tuningOption(selection, "store"),
    optionField(selection, "store"),
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

function createOpenAIChatCompletionsModel(
  selection: ProviderModelSelection,
  dependencies: BuiltinProviderAdapterRegistryOptions,
): Model {
  const maxOutputTokens = optionalPositiveInteger(
    modelOption(selection, "maxOutputTokens"),
    optionField(selection, "maxOutputTokens"),
  ) ?? selection.limits?.maxOutputTokens;
  const reasoningEffort = optionalString(
    tuningOption(selection, "reasoningEffort"),
    optionField(selection, "reasoningEffort"),
  );
  const store = optionalBoolean(
    tuningOption(selection, "store"),
    optionField(selection, "store"),
  );
  const baseURL = providerBaseURL(selection);
  const options: OpenAIChatCompletionsModelOptions = {
    ...credentials(selection),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(store === undefined ? {} : { store }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
  };
  return attachModelLimits(
    new OpenAIChatCompletionsModel(options),
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
): ProviderAdapterFactory {
  return { create };
}
