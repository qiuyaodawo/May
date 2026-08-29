import type { MayConfig } from "@may/config";
import type { Model } from "@may/core";
import {
  createBuiltinProviderModel,
  ProviderConfigurationError,
  ProviderRegistryError,
  selectProviderModel,
  type ProviderModelSelection,
  type ProviderModelSelector,
} from "@may/providers";

import { MaybeCodeConfigError } from "./errors.js";

export type MaybeCodeModelSelector = ProviderModelSelector;
export type SelectedMaybeCodeModel = ProviderModelSelection;

export function selectMaybeCodeModel(
  config: MayConfig,
  selector: MaybeCodeModelSelector = {},
): SelectedMaybeCodeModel {
  try {
    return selectProviderModel(config, selector);
  } catch (error) {
    if (error instanceof ProviderConfigurationError) {
      throw new MaybeCodeConfigError(error.message, { cause: error });
    }
    throw error;
  }
}

export function createMaybeCodeModel(
  selection: SelectedMaybeCodeModel,
): Model {
  try {
    return createBuiltinProviderModel(selection);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      throw new MaybeCodeConfigError(error.message, { cause: error });
    }
    throw error;
  }
}
