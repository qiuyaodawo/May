import type { Model } from "@may/core";
import {
  createBuiltinProviderModel,
  type ProviderAdapterRegistry,
  ProviderAdapterRegistryError,
} from "@may/providers";

import { CliConfigError } from "./errors.js";
import type { SelectedModelConfig } from "./selection.js";

export function createConfiguredModel(
  selection: SelectedModelConfig,
  registry?: ProviderAdapterRegistry,
): Model {
  try {
    return registry === undefined
      ? createBuiltinProviderModel(selection)
      : registry.create(selection);
  } catch (error) {
    if (error instanceof ProviderAdapterRegistryError) {
      throw new CliConfigError(error.message, { cause: error });
    }
    throw error;
  }
}
