export interface ProviderConfig {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly baseURL?: string;
  readonly model?: string;
  readonly [key: string]: unknown;
}

export interface ModelProfile {
  readonly provider: string;
  readonly model: string;
  readonly options?: Readonly<Record<string, unknown>>;
}

export interface MayConfig {
  readonly path: string;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ModelProfile>>;
  readonly defaultModel?: string;
}

export interface LoadMayConfigOptions {
  path?: string;
}

export interface ResolveProviderOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

export interface ResolvedModelProfile {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly providerConfig: ProviderConfig;
}
