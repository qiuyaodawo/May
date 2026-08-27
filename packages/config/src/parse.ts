import { MayConfigValidationError } from "./errors.js";
import type {
  MayConfig,
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
    return { path, providers, models };
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
  return { path, providers, models, defaultModel };
}

function parseProvider(
  value: unknown,
  path: string,
  field: string,
): ProviderConfig {
  const provider = requireObject(value, path, field);
  const result: Record<string, unknown> = { ...provider };

  for (const key of ["apiKey", "apiKeyEnv", "baseURL", "model"] as const) {
    if (provider[key] !== undefined) {
      result[key] = requireNonEmptyString(
        provider[key],
        path,
        `${field}.${key}`,
      );
    }
  }

  if (result.apiKey !== undefined && result.apiKeyEnv !== undefined) {
    throw new MayConfigValidationError(
      path,
      field,
      "must not define both apiKey and apiKeyEnv",
    );
  }
  return result as ProviderConfig;
}

function parseModel(
  value: unknown,
  path: string,
  field: string,
): ModelProfile {
  const model = requireObject(value, path, field);
  const result = {
    provider: requireNonEmptyString(model.provider, path, `${field}.provider`),
    model: requireNonEmptyString(model.model, path, `${field}.model`),
  };
  if (model.options === undefined) {
    return result;
  }
  return {
    ...result,
    options: { ...requireObject(model.options, path, `${field}.options`) },
  };
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

function requireName(name: string, path: string, field: string): void {
  if (name.trim() === "") {
    throw new MayConfigValidationError(
      path,
      field,
      "must not contain an empty name",
    );
  }
}
