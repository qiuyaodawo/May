import { MayConfigValidationError } from "./errors.js";
import type {
  ApplicationConfig,
  MayConfig,
  ModelCapabilitiesOverride,
  ModelProfile,
  ProviderConfig,
} from "./types.js";

export function parseMayConfig(value: unknown, path = "<inline>"): MayConfig {
  const root = requireObject(value, path, "config");
  const providersValue = requireObject(root.providers, path, "providers");
  const providers = Object.fromEntries(
    Object.entries(providersValue).map(([name, provider]) => {
      requireName(name, path, "providers");
      return [name, parseProvider(provider, path, `providers.${name}`)];
    }),
  );

  const modelsValue = root.models === undefined
    ? {}
    : requireObject(root.models, path, "models");
  const models = Object.fromEntries(
    Object.entries(modelsValue).map(([name, model]) => {
      requireName(name, path, "models");
      return [name, parseModel(model, path, `models.${name}`)];
    }),
  );

  const appsValue = root.apps === undefined
    ? {}
    : requireObject(root.apps, path, "apps");
  const apps = Object.fromEntries(
    Object.entries(appsValue).map(([name, app]) => {
      requireName(name, path, "apps");
      return [name, parseApplication(app, path, `apps.${name}`)];
    }),
  );

  for (const [name, model] of Object.entries(models)) {
    if (!Object.hasOwn(providers, model.provider)) {
      throw new MayConfigValidationError(
        path,
        `models.${name}.provider`,
        `references unknown provider "${model.provider}"`,
      );
    }
  }

  if (root.defaultModel === undefined) {
    return { path, providers, models, apps };
  }

  const defaultModel = requireNonEmptyString(
    root.defaultModel,
    path,
    "defaultModel",
  );
  if (!Object.hasOwn(models, defaultModel)) {
    throw new MayConfigValidationError(
      path,
      "defaultModel",
      `references unknown model "${defaultModel}"`,
    );
  }
  return { path, providers, models, apps, defaultModel };
}

function parseApplication(
  value: unknown,
  path: string,
  field: string,
): ApplicationConfig {
  return { ...requireObject(value, path, field) };
}

function parseProvider(
  value: unknown,
  path: string,
  field: string,
): ProviderConfig {
  const provider = requireObject(value, path, field);
  rejectUnknownKeys(
    provider,
    new Set(["adapter", "apiKey", "apiKeyEnv", "baseURL", "options"]),
    path,
    field,
  );
  const result: Record<string, unknown> = {
    adapter: requireNonEmptyString(
      provider.adapter,
      path,
      `${field}.adapter`,
    ),
  };

  for (const key of ["apiKey", "apiKeyEnv", "baseURL"] as const) {
    if (provider[key] !== undefined) {
      result[key] = requireNonEmptyString(
        provider[key],
        path,
        `${field}.${key}`,
      );
    }
  }

  if (provider.options !== undefined) {
    result.options = {
      ...requireObject(provider.options, path, `${field}.options`),
    };
  }

  if (result.apiKey !== undefined && result.apiKeyEnv !== undefined) {
    throw new MayConfigValidationError(
      path,
      field,
      "must not define both apiKey and apiKeyEnv",
    );
  }
  return result as unknown as ProviderConfig;
}

function parseModel(
  value: unknown,
  path: string,
  field: string,
): ModelProfile {
  const model = requireObject(value, path, field);
  rejectUnknownKeys(
    model,
    new Set([
      "provider",
      "adapter",
      "model",
      "contextWindowTokens",
      "maxOutputTokens",
      "options",
      "capabilities",
    ]),
    path,
    field,
  );
  const result = {
    provider: requireNonEmptyString(model.provider, path, `${field}.provider`),
    ...(model.adapter === undefined
      ? {}
      : {
          adapter: requireNonEmptyString(
            model.adapter,
            path,
            `${field}.adapter`,
          ),
        }),
    model: requireNonEmptyString(model.model, path, `${field}.model`),
    ...(model.contextWindowTokens === undefined
      ? {}
      : {
          contextWindowTokens: requirePositiveSafeInteger(
            model.contextWindowTokens,
            path,
            `${field}.contextWindowTokens`,
          ),
        }),
    ...(model.maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: requirePositiveSafeInteger(
            model.maxOutputTokens,
            path,
            `${field}.maxOutputTokens`,
          ),
        }),
    ...(model.capabilities === undefined
      ? {}
      : {
          capabilities: parseModelCapabilities(
            model.capabilities,
            path,
            `${field}.capabilities`,
          ),
        }),
  };
  if (model.options === undefined) {
    return result;
  }
  return {
    ...result,
    options: { ...requireObject(model.options, path, `${field}.options`) },
  };
}

function parseModelCapabilities(
  value: unknown,
  path: string,
  field: string,
): ModelCapabilitiesOverride {
  const capabilities = requireObject(value, path, field);
  rejectUnknownKeys(capabilities, new Set(["reasoning"]), path, field);
  if (capabilities.reasoning === undefined) return {};
  if (capabilities.reasoning === false) return { reasoning: false };

  const reasoning = requireObject(
    capabilities.reasoning,
    path,
    `${field}.reasoning`,
  );
  rejectUnknownKeys(
    reasoning,
    new Set(["efforts", "defaultEffort"]),
    path,
    `${field}.reasoning`,
  );
  if (!Array.isArray(reasoning.efforts)) {
    throw new MayConfigValidationError(
      path,
      `${field}.reasoning.efforts`,
      "must be an array",
    );
  }
  if (reasoning.efforts.length === 0) {
    throw new MayConfigValidationError(
      path,
      `${field}.reasoning.efforts`,
      "must contain at least one effort; use reasoning: false for unsupported models",
    );
  }
  const efforts = reasoning.efforts.map((effort, index) =>
    requireNonEmptyString(
      effort,
      path,
      `${field}.reasoning.efforts.${index}`,
    )
  );
  if (new Set(efforts).size !== efforts.length) {
    throw new MayConfigValidationError(
      path,
      `${field}.reasoning.efforts`,
      "must not contain duplicates",
    );
  }
  const defaultEffort = reasoning.defaultEffort === undefined
    ? undefined
    : requireNonEmptyString(
      reasoning.defaultEffort,
      path,
      `${field}.reasoning.defaultEffort`,
    );
  if (defaultEffort !== undefined && !efforts.includes(defaultEffort)) {
    throw new MayConfigValidationError(
      path,
      `${field}.reasoning.defaultEffort`,
      "must be listed in efforts",
    );
  }
  return {
    reasoning: {
      efforts,
      ...(defaultEffort === undefined ? {} : { defaultEffort }),
    },
  };
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  field: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw new MayConfigValidationError(
      path,
      `${field}.${unknown}`,
      "is not supported",
    );
  }
}

function requireObject(
  value: unknown,
  path: string,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MayConfigValidationError(path, field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  field: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new MayConfigValidationError(
      path,
      field,
      "must be a non-empty string",
    );
  }
  return value;
}

function requirePositiveSafeInteger(
  value: unknown,
  path: string,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new MayConfigValidationError(
      path,
      field,
      "must be a positive safe integer",
    );
  }
  return value as number;
}

function requireName(name: string, path: string, field: string): void {
  if (name.trim() === "") {
    throw new MayConfigValidationError(
      path,
      field,
      "must not contain an empty name",
    );
  }
}
