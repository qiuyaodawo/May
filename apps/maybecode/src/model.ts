import type { MayConfig } from "@may/config";
import type { Model } from "@may/core";
import {
  createBuiltinProviderAdapterRegistry,
  createBuiltinProviderModel,
  type ProviderAdapterRegistry,
  ProviderConfigurationError,
  ProviderAdapterRegistryError,
  selectProviderModel,
  type ProviderModelSelection,
  type ModelProfileSelector,
} from "@may/providers";

import { MaybeCodeConfigError } from "./errors.js";

export type MaybeCodeModelSelector = ModelProfileSelector;
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
  registry?: ProviderAdapterRegistry,
): Model {
  try {
    return registry === undefined
      ? createBuiltinProviderModel(selection)
      : registry.create(selection);
  } catch (error) {
    if (error instanceof ProviderAdapterRegistryError) {
      throw new MaybeCodeConfigError(error.message, { cause: error });
    }
    throw error;
  }
}

export function createMaybeCodeAdapterRegistry(): ProviderAdapterRegistry {
  return createBuiltinProviderAdapterRegistry();
}
