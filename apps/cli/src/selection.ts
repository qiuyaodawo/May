import {
  resolveModelProfile,
  resolveProviderConfig,
  type MayConfig,
  type ProviderConfig,
  type ResolveProviderOptions,
} from "@may/config";
import { CliConfigError } from "./errors.js";

export interface ModelSelector {
  readonly provider?: string;
  readonly model?: string;
}

export interface SelectedModelConfig {
  readonly provider: string;
  readonly model: string;
  readonly providerConfig: ProviderConfig;
  readonly options: Readonly<Record<string, unknown>>;
}

export function selectModelConfig(
  config: MayConfig,
  selector: ModelSelector = {},
  resolveOptions: ResolveProviderOptions = {},
): SelectedModelConfig {
  if (selector.provider !== undefined && selector.model !== undefined) {
    throw new CliConfigError(
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
    };
  }

  const provider = selector.provider ?? selectOnlyProvider(config);
  const providerConfig = resolveProviderConfig(config, provider, resolveOptions);
  const model = providerConfig.model;
  if (typeof model !== "string" || model.trim() === "") {
    throw new CliConfigError(
      `Set providers.${provider}.model in ${config.path}`,
    );
  }
  return { provider, model, providerConfig, options: {} };
}

function selectOnlyProvider(config: MayConfig): string {
  const providers = Object.keys(config.providers);
  if (providers.length === 0) {
    throw new CliConfigError(`No providers are configured in ${config.path}`);
  }
  if (providers.length > 1) {
    throw new CliConfigError(
      "Select a provider with --provider or configure defaultModel",
    );
  }
  return providers[0]!;
}
