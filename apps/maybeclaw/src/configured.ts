import { loadMayConfig, type MayConfig } from "@may/config";
import { resolveRunBudget, type RunBudget, type Model } from "@may/core";
import { createBuiltinProviderModel, selectProviderModel, type ProviderModelSelection } from "@may/providers";
import { digest, type TaskSpec } from "./types.js";
import { hostSettings } from "./settings.js";

export const DEFAULT_TASK_BUDGET: RunBudget = Object.freeze({
  maxSteps: 12, maxModelCalls: 12, maxToolCalls: 24, maxDurationMs: 180_000, maxTotalTokens: 131_072,
});

export interface ModelDependencies {
  readonly loadConfig?: (options: { path?: string }) => Promise<MayConfig>;
  readonly createModel?: (selection: ProviderModelSelection) => Model;
}

export async function selectTaskModel(configPath: string | undefined, model: string | undefined, deps: ModelDependencies = {}) {
  const config = await (deps.loadConfig ?? loadMayConfig)(configPath === undefined ? {} : { path: configPath });
  const selection = selectProviderModel(config, model === undefined ? {} : { model });
  const configured = configuredBudget(config);
  const runBudget = resolveRunBudget(DEFAULT_TASK_BUDGET, configured);
  return { configPath: config.path, modelProfile: selection.profile, modelFingerprint: modelFingerprint(selection), runBudget };
}

export async function loadTaskModel(spec: TaskSpec, deps: ModelDependencies = {}): Promise<Model> {
  const config = await (deps.loadConfig ?? loadMayConfig)({ path: spec.configPath });
  const selection = selectProviderModel(config, { model: spec.modelProfile });
  if (modelFingerprint(selection) !== spec.modelFingerprint) throw new Error("Model configuration changed; restore the original profile or submit a new task");
  const current = resolveRunBudget(DEFAULT_TASK_BUDGET, configuredBudget(config));
  // Do not silently loosen a newly tightened host budget for an old queued task.
  if (digest(resolveRunBudget(current, spec.runBudget)) !== digest(spec.runBudget)) throw new Error("Host budget changed; submit a new task under the current limits");
  for (const key of ["maxTokens", "maxOutputTokens"] as const) {
    const value = selection.options[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) throw new Error(`Model ${key} must be a positive integer`);
  }
  const outputLimit = Math.min(4096, selection.limits?.maxOutputTokens ?? 4096,
    ...[selection.options.maxTokens, selection.options.maxOutputTokens].filter((n): n is number => typeof n === "number" && n > 0));
  return (deps.createModel ?? createBuiltinProviderModel)({ ...selection,
    options: { ...selection.options, maxTokens: outputLimit, maxOutputTokens: outputLimit },
    limits: { ...selection.limits, maxOutputTokens: outputLimit } });
}

function modelFingerprint(selection: ProviderModelSelection): string {
  // Store only a digest, never provider credentials or model option values.
  // API key rotation is allowed; adapter, endpoint, model and options are pinned.
  return digest({ profile: selection.profile, provider: selection.provider, adapter: selection.adapter,
    model: selection.model, baseURL: selection.providerConfig.baseURL,
    options: selection.options, limits: selection.limits });
}

function configuredBudget(config: MayConfig): RunBudget | undefined {
  const app = config.apps?.maybeclaw;
  hostSettings(config);
  return app?.runBudget as RunBudget | undefined;
}
