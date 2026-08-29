import type { ProviderConfig } from "@may/config";
import type { Model, ModelLimits } from "@may/core";

export interface ProviderModelSelector {
  readonly provider?: string;
  readonly model?: string;
}

export interface ProviderModelSelection {
  readonly provider: string;
  readonly model: string;
  readonly providerConfig: ProviderConfig;
  readonly options: Readonly<Record<string, unknown>>;
  readonly limits?: ModelLimits;
}

export interface ProviderFactory {
  create(selection: ProviderModelSelection): Model;
}
