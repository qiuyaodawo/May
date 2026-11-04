import { MayConfigValidationError } from "./errors.js";
import { validateMayConfigDocument } from "./schema.js";
import type { MayConfig, ModelCapabilitiesOverride } from "./types.js";

interface MayConfigDocument extends Omit<MayConfig, "path" | "models"> {
  readonly models?: MayConfig["models"];
}

export function parseMayConfig(value: unknown, path = "<inline>"): MayConfig {
  validateMayConfigDocument(value, path);
  const { providers, models = {}, apps = {}, defaultModel } = value as MayConfigDocument;
  for (const [name, provider] of Object.entries(providers)) {
    checkDefaultEffort(provider.capabilities, path, `providers.${name}.capabilities`);
  }
  for (const [name, model] of Object.entries(models)) {
    if (!Object.hasOwn(providers, model.provider)) {
      throw new MayConfigValidationError(path, `models.${name}.provider`, `references unknown provider "${model.provider}"`);
    }
    checkDefaultEffort(model.capabilities, path, `models.${name}.capabilities`);
  }
  if (defaultModel === undefined) return { path, providers, models, apps };
  if (!Object.hasOwn(models, defaultModel)) {
    throw new MayConfigValidationError(path, "defaultModel", `references unknown model "${defaultModel}"`);
  }
  return { path, providers, models, apps, defaultModel };
}

function checkDefaultEffort(capabilities: ModelCapabilitiesOverride | undefined, path: string, field: string): void {
  const reasoning = capabilities?.reasoning;
  if (!reasoning || reasoning.defaultEffort === undefined || reasoning.efforts.includes(reasoning.defaultEffort)) return;
  throw new MayConfigValidationError(path, `${field}.reasoning.defaultEffort`, "must be listed in efforts");
}
