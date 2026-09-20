import type { GoalBudget, GoalState, GoalStatus } from "./types.js";

export function goalBudget(value: GoalBudget = {}): GoalState["budget"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("goal budget must be an object");
  for (const [key, limit] of Object.entries(value)) {
    if (!["maxRuns", "maxTotalTokens", "maxDurationMs"].includes(key)) throw new TypeError(`Unknown goal budget: ${key}`);
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError(`${key} must be a positive safe integer`);
  }
  const budget = { ...value };
  if (budget.maxRuns !== undefined && budget.maxRuns > 10_000) throw new RangeError("maxRuns must not exceed 10000");
  if (budget.maxDurationMs !== undefined && budget.maxDurationMs > 2_147_483_647) throw new RangeError("maxDurationMs exceeds the timer limit");
  return budget;
}

export function goalText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768) throw new TypeError(`${field} must contain 1..32768 characters`);
  return value.trim();
}

export function restoreGoal(value: unknown, sessionId: string): GoalState | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new TypeError("Invalid goal state");
  const state = value as GoalState;
  if (state.version !== 1 || state.sessionId !== sessionId) throw new Error("Unsupported goal state or mismatched session");
  goalText(state.id, "id"); goalText(state.objective, "objective");
  const statuses: GoalStatus[] = ["active", "paused", "blocked", "completed", "cancelled", "failed", "budget_exhausted"];
  if (!statuses.includes(state.status)) throw new Error("Invalid goal status");
  if (!state.budget || typeof state.budget !== "object") throw new Error("Missing goal budget");
  goalBudget(state.budget);
  if (!state.usage || typeof state.usage.usageComplete !== "boolean") throw new Error("Invalid goal usage");
  for (const count of [state.usage.runs, state.usage.totalTokens, state.usage.elapsedMs, state.createdAt, state.updatedAt]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid goal counter");
  }
  if (typeof state.progress !== "string" || state.progress.length > 32_768) throw new Error("Invalid goal progress");
  if (state.reason !== undefined) goalText(state.reason, "reason");
  if (!Array.isArray(state.runIds) || state.runIds.some(id => typeof id !== "string" || !id) || new Set(state.runIds).size !== state.runIds.length) throw new Error("Invalid goal runs");
  if (!Array.isArray(state.calls) || state.calls.length > 10_000) throw new Error("Invalid goal calls");
  const ids = new Set<string>();
  let total = 0;
  for (const call of state.calls) {
    if (!call || typeof call !== "object" || typeof call.id !== "string" || !call.id || ids.has(call.id) || !["pending", "settled", "unknown"].includes(call.status)) throw new Error("Invalid goal call");
    ids.add(call.id);
    if (call.runId !== undefined) goalText(call.runId, "runId");
    if (call.tokens !== undefined && (!Number.isSafeInteger(call.tokens) || call.tokens < 0)) throw new Error("Invalid goal tokens");
    if (call.status === "settled" && call.tokens === undefined) throw new Error("Settled call has no token count");
    if (call.status === "unknown" && state.usage.usageComplete) throw new Error("Unknown usage cannot be complete");
    total += call.tokens ?? 0;
  }
  if (!Number.isSafeInteger(total) || total !== state.usage.totalTokens) throw new Error("Goal usage does not match its call records");
  if (state.report) {
    if (!["completed", "blocked"].includes(state.report.status)) throw new Error("Invalid goal report");
    goalText(state.report.evidence, "evidence");
  }
  if (state.completion) {
    if (!["model", "verifier"].includes(state.completion.source)) throw new Error("Invalid completion source");
    goalText(state.completion.evidence, "evidence");
  }
  if (state.status === "completed" && !state.completion) throw new Error("Completed goal has no evidence");
  return structuredClone(state);
}
