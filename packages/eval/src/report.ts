import type { EvalPlan, TrialState, MeasuredValue } from "./types.js";

export interface MetricDistribution { readonly count: number; readonly planned: number; readonly complete: number; readonly coverage: number; readonly min?: number; readonly max?: number; readonly mean?: number; readonly median?: number; }
export interface EvalVariantReport {
  readonly variantId: string;
  readonly assisted: boolean;
  readonly planned: number;
  readonly executed: number;
  readonly successful: number;
  readonly successRate: number;
  readonly outcomes: Readonly<Record<string, number>>;
  readonly durationMs: MetricDistribution;
  readonly cost: MetricDistribution;
  readonly costCurrency?: string;
  readonly cases: readonly { readonly caseId: string; readonly planned: number; readonly successful: number; readonly successRate: number }[];
}
export interface EvalReport { readonly schemaVersion: 1; readonly experimentId: string; readonly planned: number; readonly recorded: number; readonly variants: readonly EvalVariantReport[]; readonly trials: readonly TrialState[]; readonly plan: EvalPlan; }
export interface EvalComparisonThresholds { readonly minimumSuccessRate?: number; readonly allowedRegressedCases?: readonly string[]; readonly maxCostIncreaseRatio?: number; }
export interface EvalComparison { readonly compatible: boolean; readonly passed: boolean; readonly differences: readonly { readonly caseId: string; readonly baselineSuccessRate: number; readonly candidateSuccessRate: number }[]; readonly failures: readonly string[]; readonly baseline: EvalVariantReport; readonly candidate: EvalVariantReport; }

export function createEvalReport(plan: EvalPlan, states: readonly TrialState[]): EvalReport {
  const byId = new Map(states.map(value => [value.trial.id, value]));
  const variants = plan.experiment.variants.map(variant => {
    const trials = plan.trials.filter(value => value.variantId === variant.id);
    const recorded = trials.map(value => byId.get(value.id)).filter((value): value is TrialState => value !== undefined);
    const successful = recorded.filter(isSuccessful).length;
    const outcomes: Record<string, number> = {};
    for (const trial of trials) {
      const state = byId.get(trial.id);
      const key = state === undefined ? "not-started" : state.endedAt === undefined ? "running" : state.infrastructureStatus !== "ready" ? `infrastructure-${state.infrastructureStatus}` : `${state.executionStatus ?? "unknown"}/${state.taskVerdict}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    const currencies = new Set(recorded.filter(value => value.metrics.cost.amount !== undefined).map(value => value.metrics.cost.currency));
    const currency = currencies.size === 1 ? currencies.values().next().value : undefined;
    return { variantId: variant.id, assisted: variant.assisted === true || recorded.some(value => (value.metrics.humanInterventions.value ?? 0) > 0), planned: trials.length, executed: recorded.filter(value => value.executionStatus !== undefined).length,
      successful, successRate: successful / trials.length, outcomes,
      durationMs: distribution(recorded.map(value => value.metrics.durationMs), trials.length),
      cost: distribution(recorded.map(value => ({ ...(currency !== undefined && value.metrics.cost.currency === currency && value.metrics.cost.amount !== undefined ? { value: value.metrics.cost.amount } : {}), complete: currency !== undefined && value.metrics.cost.complete, missingReasons: value.metrics.cost.missingReasons })), trials.length),
      ...(currency === undefined ? {} : { costCurrency: currency }),
      cases: plan.experiment.cases.map(item => { const planned = trials.filter(value => value.caseId === item.id).length; const successes = recorded.filter(value => value.trial.caseId === item.id && isSuccessful(value)).length; return { caseId: item.id, planned, successful: successes, successRate: successes / planned }; }) };
  });
  return { schemaVersion: 1, experimentId: plan.experiment.id, planned: plan.trials.length, recorded: states.length, variants, trials: [...states], plan };
}
export function isSuccessful(state: TrialState): boolean { return state.endedAt !== undefined && state.executionStatus === "completed" && state.taskVerdict === "passed" && state.infrastructureStatus === "ready"; }
export function compareEvalReports(baseline: EvalReport, candidate: EvalReport, thresholds: EvalComparisonThresholds = {}, options: { readonly baselineVariantId?: string; readonly candidateVariantId?: string } = {}): EvalComparison {
  const left = selectVariant(baseline, options.baselineVariantId); const right = selectVariant(candidate, options.candidateVariantId);
  if (thresholds.minimumSuccessRate !== undefined && (!Number.isFinite(thresholds.minimumSuccessRate) || thresholds.minimumSuccessRate < 0 || thresholds.minimumSuccessRate > 1)) throw new RangeError("minimumSuccessRate must be between zero and one");
  if (thresholds.maxCostIncreaseRatio !== undefined && (!Number.isFinite(thresholds.maxCostIncreaseRatio) || thresholds.maxCostIncreaseRatio < 0)) throw new RangeError("maxCostIncreaseRatio must be nonnegative");
  const failures: string[] = []; let compatible = true;
  const leftIds = new Set(baseline.plan.experiment.cases.map(value => value.id)); const rightIds = new Set(candidate.plan.experiment.cases.map(value => value.id));
  if (leftIds.size !== rightIds.size || [...leftIds].some(id => !rightIds.has(id))) { compatible = false; failures.push("Case sets differ"); }
  for (const id of leftIds) {
    const leftTrial = baseline.plan.trials.find(value => value.caseId === id)!; const rightTrial = candidate.plan.trials.find(value => value.caseId === id);
    if (rightTrial === undefined) continue;
    const a = baseline.plan.fingerprints[leftTrial.id]!; const b = candidate.plan.fingerprints[rightTrial.id]!;
    if (a.case !== b.case || a.environment !== b.environment || a.evaluators !== b.evaluators) { compatible = false; failures.push(`Case or environment or evaluator changed: ${id}`); }
    const leftSources = new Set(baseline.trials.filter(value => value.trial.caseId === id && value.trial.variantId === left.variantId).map(value => value.evaluationTarget?.data?.baselineDigest).filter(value => typeof value === "string"));
    const rightSources = new Set(candidate.trials.filter(value => value.trial.caseId === id && value.trial.variantId === right.variantId).map(value => value.evaluationTarget?.data?.baselineDigest).filter(value => typeof value === "string"));
    if (leftSources.size > 0 || rightSources.size > 0) if (leftSources.size !== 1 || rightSources.size !== 1 || [...leftSources][0] !== [...rightSources][0]) { compatible = false; failures.push(`Environment source contents differ: ${id}`); }
  }
  if (left.assisted !== right.assisted) { compatible = false; failures.push("Human assistance modes differ"); }
  const differences = left.cases.flatMap(value => { const other = right.cases.find(item => item.caseId === value.caseId); return other === undefined ? [] : [{ caseId: value.caseId, baselineSuccessRate: value.successRate, candidateSuccessRate: other.successRate }]; });
  for (const difference of differences) if (thresholds.allowedRegressedCases !== undefined && difference.candidateSuccessRate < difference.baselineSuccessRate && !thresholds.allowedRegressedCases.includes(difference.caseId)) failures.push(`Case success rate decreased: ${difference.caseId}`);
  if (thresholds.minimumSuccessRate !== undefined && right.successRate < thresholds.minimumSuccessRate) failures.push("Candidate success rate is below the configured minimum");
  if (thresholds.maxCostIncreaseRatio !== undefined) {
    const a = left.cost.mean; const b = right.cost.mean;
    if (a === undefined || b === undefined || left.costCurrency !== right.costCurrency || left.cost.complete !== left.planned || right.cost.complete !== right.planned) failures.push("Complete comparable cost measurements are unavailable");
    else if (b > a * (1 + thresholds.maxCostIncreaseRatio)) failures.push("Candidate cost increase exceeds the configured limit");
  }
  return { compatible, passed: compatible && failures.length === 0, differences, failures, baseline: left, candidate: right };
}
export function renderEvalReportMarkdown(report: EvalReport): string {
  const lines = [`# Eval ${report.experimentId}`, "", `Planned trials: ${report.planned}. Recorded trials: ${report.recorded}.`, ""];
  for (const variant of report.variants) lines.push(`## ${variant.variantId}`, "", `Success: ${variant.successful}/${variant.planned} (${(variant.successRate * 100).toFixed(1)}%).`, `Execution duration mean: ${variant.durationMs.mean?.toFixed(1) ?? "unavailable"} ms; coverage: ${variant.durationMs.count}/${variant.planned}.`, `Cost mean: ${variant.cost.mean?.toFixed(6) ?? "unavailable"} ${variant.costCurrency ?? ""}; coverage: ${variant.cost.count}/${variant.planned}.`, "", ...Object.entries(variant.outcomes).map(([outcome, count]) => `- ${outcome}: ${count}`), "");
  return lines.join("\n");
}
function selectVariant(report: EvalReport, id?: string): EvalVariantReport { if (id === undefined && report.variants.length !== 1) throw new Error("Select a variant when comparing an experiment with multiple variants"); const value = id === undefined ? report.variants[0] : report.variants.find(value => value.variantId === id); if (value === undefined) throw new Error("Unknown comparison variant"); return value; }
function distribution(values: readonly MeasuredValue[], planned: number): MetricDistribution {
  const measured = values.filter(value => value.value !== undefined).map(value => value.value!).sort((a, b) => a - b);
  if (measured.length === 0) return { count: 0, planned, complete: 0, coverage: 0 };
  return { count: measured.length, planned, complete: values.filter(value => value.value !== undefined && value.complete).length, coverage: measured.length / planned, min: measured[0]!, max: measured.at(-1)!, mean: measured.reduce((sum, value) => sum + value, 0) / measured.length, median: measured.length % 2 === 1 ? measured[Math.floor(measured.length / 2)]! : (measured[measured.length / 2 - 1]! + measured[measured.length / 2]!) / 2 };
}
