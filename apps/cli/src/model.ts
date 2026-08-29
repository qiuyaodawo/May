import type { Model } from "@may/core";
import {
  createBuiltinProviderModel,
  ProviderRegistryError,
} from "@may/providers";

import { CliConfigError } from "./errors.js";
import type { SelectedModelConfig } from "./selection.js";

export function createConfiguredModel(selection: SelectedModelConfig): Model {
  try {
    return createBuiltinProviderModel(selection);
  } catch (error) {
    if (error instanceof ProviderRegistryError) {
      throw new CliConfigError(error.message, { cause: error });
    }
    throw error;
  }
}
