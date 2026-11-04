import { omitUndefined } from "../core/omit-undefined.js";
import { MayConfigResolutionError } from "./errors.js";
import type {
  MayConfig,
  ProviderConfig,
  ResolvedModelProfile,
  ResolveProviderOptions,
} from "./types.js";

export function resolveProviderConfig(
  config: MayConfig,
  name: string,
  options: ResolveProviderOptions = {},
): ProviderConfig {
  if (!Object.hasOwn(config.providers, name)) {
    throw new MayConfigResolutionError(`Unknown provider "${name}"`);
  }
  const provider = config.providers[name]!;

  const resolved: Record<string, unknown> = { ...provider };
  if (provider.apiKeyEnv !== undefined) {
    const env = options.env ?? process.env;
    const apiKey = env[provider.apiKeyEnv];
    if (apiKey === undefined || apiKey.trim() === "") {
      throw new MayConfigResolutionError(
        `Provider "${name}" requires environment variable ${provider.apiKeyEnv}`,
      );
    }
    resolved.apiKey = apiKey;
  }
  return resolved as unknown as ProviderConfig;
}

export function resolveModelProfile(
  config: MayConfig,
  name?: string,
  options: ResolveProviderOptions = {},
): ResolvedModelProfile {
  const profileName = name ?? config.defaultModel;
  if (profileName === undefined) {
    throw new MayConfigResolutionError(
      "No model was selected and defaultModel is not configured",
    );
  }

  if (!Object.hasOwn(config.models, profileName)) {
    throw new MayConfigResolutionError(`Unknown model "${profileName}"`);
  }
  const profile = config.models[profileName]!;
  const providerConfig = resolveProviderConfig(
    config,
    profile.provider,
    options,
  );
  return omitUndefined({
    name: profileName,
    provider: profile.provider,
    adapter: profile.adapter ?? providerConfig.adapter,
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    maxOutputTokens: profile.maxOutputTokens,
    options: {
      ...(providerConfig.options ?? {}),
      ...(profile.options ?? {}),
    },
    capabilities: profile.capabilities,
    providerConfig,
  });
}
