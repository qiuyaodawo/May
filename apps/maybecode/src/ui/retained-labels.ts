import type { MaybeCodeController, MaybeCodeReasoningEffortState } from "../controller.js";
import type { MaybeCodeTerminalView } from "./terminal-view.js";

export function modelLabel(
  app: MaybeCodeController,
  effort: MaybeCodeReasoningEffortState | "loading" = "loading",
): string {
  const info = app.application.modelInfo;
  if (info === undefined) return "unknown · effort: unknown";
  const endpoint = `${info.provider}/${info.model}`;
  const model = info.profile === undefined ? endpoint : `${info.profile} (${endpoint})`;
  return `${model} · effort: ${reasoningEffortLabel(effort)}${info.searchStatus ? ` · ${info.searchStatus}` : ""}`;
}

function reasoningEffortLabel(state: MaybeCodeReasoningEffortState | "loading"): string {
  if (state === "loading") return "…";
  if (state.status === "unsupported") return "n/a";
  if (state.status === "unknown") return "unknown";
  return state.effectiveEffort ?? state.defaultEffort ?? "default";
}

export async function resolvedModelLabel(app: MaybeCodeController): Promise<string> {
  try {
    return modelLabel(app, await app.getReasoningEffort());
  } catch {
    return modelLabel(app, unknownReasoningEffort());
  }
}

export async function refreshModelLabel(view: MaybeCodeTerminalView, app: MaybeCodeController): Promise<void> {
  const identity = modelIdentity(app);
  const label = await resolvedModelLabel(app);
  if (identity === modelIdentity(app)) view.setModel(label);
}

function modelIdentity(app: MaybeCodeController): string {
  const model = app.application.modelInfo;
  return model === undefined ? "" : `${model.profile ?? ""}\u0000${model.provider}\u0000${model.model}`;
}

function unknownReasoningEffort(): MaybeCodeReasoningEffortState {
  return {
    status: "unknown",
    source: "unknown",
    efforts: [],
    overridden: false,
  };
}

export function reasoningEffortUnavailable(state: MaybeCodeReasoningEffortState): string {
  return state.status === "unsupported"
    ? "The active model does not support effort-based reasoning"
    : "Reasoning effort capability is unknown for the active model";
}

export function reasoningEffortChanged(state: MaybeCodeReasoningEffortState): string {
  const effort = state.effectiveEffort ?? "provider/model default";
  return `Reasoning effort: ${effort}${state.overridden ? " (runtime override)" : ""}`;
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || ("code" in error && error.code === "RUN_CANCELLED"));
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
