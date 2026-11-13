import { assertJson } from "./validation.js";
import type {
  EvalCase,
  EvalError,
  EvalPhase,
  EvaluationResult,
  EvaluationRevision,
  TaskVerdict,
  TrialState,
} from "./types.js";

class PhaseLimitError extends Error {
  readonly code = "phase-timeout";
  constructor(readonly phase: EvalPhase) {
    super(`${phase} exceeded its timeout`);
    this.name = "PhaseLimitError";
  }
}

/** @experimental */
export function resolveTaskVerdict(
  item: EvalCase,
  revisions: readonly EvaluationRevision[],
): { readonly verdict: TaskVerdict; readonly awaitingReview: boolean } {
  const required = item.evaluators
    .filter((value) => value.required)
    .map((reference) =>
      revisions
        .filter((value) => value.evaluatorId === reference.id && value.evaluatorVersion === reference.version)
        .at(-1),
    );
  const awaitingReview = required.some((value) => value?.result.verdict === "awaiting-review");
  if (
    required.some(
      (value) => value?.result.verdict === "failed" || value?.result.checks.some((check) => check.verdict === "failed"),
    )
  )
    return { verdict: "failed", awaitingReview };
  if (
    required.every(
      (value) => value?.result.verdict === "passed" && value.result.checks.every((check) => check.verdict === "passed"),
    )
  )
    return { verdict: "passed", awaitingReview };
  return { verdict: revisions.length === 0 ? "not-evaluated" : "inconclusive", awaitingReview };
}
export function applyRevision(state: TrialState, revision: EvaluationRevision, item: EvalCase): TrialState {
  const evaluations = [...state.evaluations, revision];
  const verdict = resolveTaskVerdict(item, evaluations);
  return { ...state, evaluations, taskVerdict: verdict.verdict, awaitingReview: verdict.awaitingReview };
}
export function addError(state: TrialState, error: EvalError): TrialState {
  return { ...state, errors: [...state.errors, error] };
}
export function validateResult(result: EvaluationResult): void {
  assertJson(result);
  if (
    !["passed", "failed", "inconclusive", "awaiting-review"].includes(result.verdict) ||
    !Array.isArray(result.checks) ||
    !Array.isArray(result.evidence)
  )
    throw new TypeError("Invalid evaluation result");
  for (const check of result.checks)
    if (!check.id || !["passed", "failed", "inconclusive"].includes(check.verdict))
      throw new TypeError("Invalid evaluation check");
  for (const score of Object.values(result.scores ?? {}))
    if (!Number.isFinite(score)) throw new TypeError("Scores must be finite");
}
export async function timed<T>(
  phase: EvalPhase,
  timeoutMs: number,
  outer: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(outer?.reason ?? new Error("Evaluation cancelled"));
  if (outer?.aborted) abort();
  else outer?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
      timer = setTimeout(() => controller.abort(new PhaseLimitError(phase)), timeoutMs);
    });
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      cancellation,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort);
    outer?.removeEventListener("abort", abort);
  }
}
export function now(): string {
  return new Date().toISOString();
}
