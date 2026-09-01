import type {
  ModelCapabilitiesOverride,
  ProviderConfig,
} from "@may/config";
import type { Model, ModelLimits } from "@may/core";

export interface ModelProfileSelector {
  readonly model?: string;
}

export interface ProviderModelSelection {
  readonly profile: string;
  readonly provider: string;
  readonly adapter: string;
  readonly model: string;
  readonly providerConfig: ProviderConfig;
  readonly options: Readonly<Record<string, unknown>>;
  readonly capabilities?: ModelCapabilitiesOverride;
  readonly limits?: ModelLimits;
}

export interface ProviderAdapterFactory {
  create(selection: ProviderModelSelection): Model;
}
