import {
  resolveModelProfile,
  type MayConfig,
  type ResolveProviderOptions,
} from "@may/config";
import type { ModelLimits } from "@may/core";

import { ProviderConfigurationError } from "./errors.js";
import type {
  ProviderModelSelection,
  ModelProfileSelector,
} from "./types.js";

export function selectProviderModel(
  config: MayConfig,
  selector: ModelProfileSelector = {},
  resolveOptions: ResolveProviderOptions = {},
): ProviderModelSelection {
  const profileName = selector.model ?? config.defaultModel ?? onlyModel(config);
  const profile = resolveModelProfile(config, profileName, resolveOptions);
  return {
    profile: profile.name,
    provider: profile.provider,
    adapter: profile.adapter,
    model: profile.model,
    providerConfig: profile.providerConfig,
    options: profile.options,
    ...(profile.capabilities === undefined
      ? {}
      : { capabilities: profile.capabilities }),
    ...modelLimits(profile.contextWindowTokens, profile.maxOutputTokens),
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

function onlyModel(config: MayConfig): string {
  const models = Object.keys(config.models);
  if (models.length === 0) {
    throw new ProviderConfigurationError(
      `No model profiles are configured in ${config.path}`,
    );
  }
  if (models.length > 1) {
    throw new ProviderConfigurationError(
      "Select a model with --model or configure defaultModel",
    );
  }
  return models[0]!;
}
