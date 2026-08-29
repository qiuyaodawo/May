import {
  resolveModelProfile,
  resolveProviderConfig,
  type MayConfig,
  type ResolveProviderOptions,
} from "@may/config";
import type { ModelLimits } from "@may/core";

import { ProviderConfigurationError } from "./errors.js";
import type {
  ProviderModelSelection,
  ProviderModelSelector,
} from "./types.js";

export function selectProviderModel(
  config: MayConfig,
  selector: ProviderModelSelector = {},
  resolveOptions: ResolveProviderOptions = {},
): ProviderModelSelection {
  if (selector.provider !== undefined && selector.model !== undefined) {
    throw new ProviderConfigurationError(
      "A provider and model profile cannot be selected together",
    );
  }

  if (
    selector.model !== undefined ||
    (selector.provider === undefined && config.defaultModel !== undefined)
  ) {
    const profile = resolveModelProfile(config, selector.model, resolveOptions);
    return {
      provider: profile.provider,
      model: profile.model,
      providerConfig: profile.providerConfig,
      options: profile.options,
      ...modelLimits(profile.contextWindowTokens, profile.maxOutputTokens),
    };
  }

  const provider = selector.provider ?? onlyProvider(config);
  const providerConfig = resolveProviderConfig(config, provider, resolveOptions);
  const model = providerConfig.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new ProviderConfigurationError(
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
    throw new ProviderConfigurationError(
      `No providers are configured in ${config.path}`,
    );
  }
  if (providers.length > 1) {
    throw new ProviderConfigurationError(
      "Select a provider with --provider or configure defaultModel",
    );
  }
  return providers[0]!;
}
