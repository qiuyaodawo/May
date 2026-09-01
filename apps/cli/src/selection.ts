import type {
  MayConfig,
  ResolveProviderOptions,
} from "@may/config";
import {
  ProviderConfigurationError,
  selectProviderModel,
  type ProviderModelSelection,
  type ModelProfileSelector,
} from "@may/providers";

import { CliConfigError } from "./errors.js";

export type ModelSelector = ModelProfileSelector;
export type SelectedModelConfig = ProviderModelSelection;

export function selectModelConfig(
  config: MayConfig,
  selector: ModelSelector = {},
  resolveOptions: ResolveProviderOptions = {},
): SelectedModelConfig {
  try {
    return selectProviderModel(config, selector, resolveOptions);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      throw new CliConfigError(error.message, { cause: error });
    }
    throw error;
  }
}
