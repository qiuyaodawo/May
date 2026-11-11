import { omitUndefined } from "@sortedyuan/may/core";
import type { MaybeCodeModelInfo, MaybeCodeReasoningEffortState } from "./controller.js";
import { MaybeCodeUsageError } from "./errors.js";
import type { MaybeCodeModelConfiguration } from "./workspace.js";
import type { ActiveWorkspaceOptions } from "./workspace-state.js";

export function unknownReasoningEffort(): MaybeCodeReasoningEffortState {
  return {
    status: "unknown",
    source: "unknown",
    efforts: [],
    overridden: false,
  };
}

export function withModelConfiguration(
  options: ActiveWorkspaceOptions,
  configuration: MaybeCodeModelConfiguration,
  runtimeOptions?: Readonly<Record<string, unknown>>,
): ActiveWorkspaceOptions {
  const { model: _model, modelInfo: _modelInfo, contextBudget: _contextBudget, ...unchanged } = options;
  return {
    ...unchanged,
    model: configuration.model,
    modelInfo: configuration.modelInfo,
    modelRuntimeOptions: runtimeOptions ?? configuredModelOptions(options, configuration.modelInfo.profile),
    ...(configuration.contextBudget === undefined ? {} : { contextBudget: configuration.contextBudget }),
  };
}

export function configuredModelOptions(
  options: ActiveWorkspaceOptions,
  profile: string | undefined,
): Readonly<Record<string, unknown>> {
  return omitUndefined({
    webSearch: options.webSearch === false ? false : undefined,
    reasoningEffort: options.modelProfiles?.find((item) => item.name === profile)?.reasoningEffort,
  });
}

export function readHistoricalModel(
  value: unknown,
): MaybeCodeModelInfo & { readonly runtimeOptions: Readonly<Record<string, unknown>> } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MaybeCodeUsageError("Historical model identity is invalid");
  const saved = value as Record<string, unknown>;
  for (const key of ["provider", "model"])
    if (typeof saved[key] !== "string" || !saved[key])
      throw new MaybeCodeUsageError(`Historical model ${key} is invalid`);
  for (const key of ["profile", "adapter"])
    if (saved[key] !== undefined && typeof saved[key] !== "string")
      throw new MaybeCodeUsageError(`Historical model ${key} is invalid`);
  if (!saved.runtimeOptions || typeof saved.runtimeOptions !== "object" || Array.isArray(saved.runtimeOptions))
    throw new MaybeCodeUsageError("Historical model options are invalid");
  return saved as unknown as MaybeCodeModelInfo & { readonly runtimeOptions: Readonly<Record<string, unknown>> };
}

export function assertHistoricalModel(saved: MaybeCodeModelInfo, current: MaybeCodeModelInfo | undefined): void {
  if (
    !current ||
    saved.provider !== current.provider ||
    saved.model !== current.model ||
    saved.adapter !== current.adapter
  ) {
    throw new MaybeCodeUsageError(
      "The selected history position requires its original provider, model and adapter configuration",
    );
  }
}
