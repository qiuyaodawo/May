export interface ProviderConfig {
  readonly adapter: string;
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly baseURL?: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly capabilities?: ModelCapabilitiesOverride;
}

export interface ReasoningEffortCapabilitiesOverride {
  /** Concrete effort levels exposed by this model through this connection. */
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}

export interface ModelCapabilitiesOverride {
  /** false explicitly declares that effort-based reasoning is unsupported. */
  readonly reasoning?: false | ReasoningEffortCapabilitiesOverride;
  readonly fields?: Readonly<Partial<Record<ModelCapabilityKey, ModelCapabilityDeclaration>>>;
}

export const MODEL_CAPABILITY_KEYS = [
  "input.text", "input.image", "input.audio", "input.file", "input.resource",
  "input.image.sources", "input.audio.sources", "input.file.sources",
  "output.text", "output.image", "output.audio", "tools", "tools.maxCalls",
  "structuredOutput.json", "structuredOutput.jsonSchema", "structuredOutput.schemaDialects",
  "structuredOutput.schemaConstraint", "contextWindowTokens", "maxOutputTokens",
  "maxImages", "maxAttachments", "maxAttachmentBytes", "fileTypes", "parameters",
  "contextCompaction", "reasoning.modes",
] as const;

export type ModelCapabilityKey = typeof MODEL_CAPABILITY_KEYS[number];
export type ModelCapabilityDeclaration = boolean | number | readonly string[] | Readonly<Record<string, unknown>>;

export interface ModelProfile {
  readonly provider: string;
  readonly adapter?: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly options?: Readonly<Record<string, unknown>>;
  /** User-supplied model capability metadata; takes precedence over discovery. */
  readonly capabilities?: ModelCapabilitiesOverride;
}

export type ApplicationConfig = Readonly<Record<string, unknown>>;

export interface MayConfig {
  readonly path: string;
  readonly providers: Readonly<Record<string, ProviderConfig>>;
  readonly models: Readonly<Record<string, ModelProfile>>;
  readonly apps?: Readonly<Record<string, ApplicationConfig>>;
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
  readonly adapter: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly maxOutputTokens?: number;
  readonly options: Readonly<Record<string, unknown>>;
  readonly capabilities?: ModelCapabilitiesOverride;
  readonly providerConfig: ProviderConfig;
}
