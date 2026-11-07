import type { ModelCapabilitiesOverride, ProviderConfig } from "@sortedyuan/may/config";
import type { Model, ModelLimits } from "@sortedyuan/may/core";

/** @experimental */
export interface ModelProfileSelector {
  readonly model?: string;
}

/** @experimental */
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

/** @experimental */
export interface ProviderAdapterFactory {
  create(selection: ProviderModelSelection): Model;
}
