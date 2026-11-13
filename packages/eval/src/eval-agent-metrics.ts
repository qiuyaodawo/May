import { omitUndefined } from "@sortedyuan/may/core";
import { type TaskAssessment } from "@sortedyuan/observability";
import type { EvalAgentIdentities, EvalAgentMetrics } from "./telemetry.js";
import type { EvalIdentities, EvalMetrics, MeasuredValue } from "./types.js";

/** @experimental */
export function evalIdentities(identities: EvalAgentIdentities): EvalIdentities {
  return identities;
}

/** @experimental */
export function evalMetrics(metrics: EvalAgentMetrics): Partial<EvalMetrics> {
  const costGroups = metrics.costs;
  const currencies = new Set(costGroups.map((cost) => cost.currency));
  const known = costGroups.filter((cost) => cost.amount !== undefined);
  const complete =
    metrics.coverageComplete &&
    costGroups.length > 0 &&
    currencies.size === 1 &&
    costGroups.every((cost) => cost.complete);
  const missingReasons = [...new Set(costGroups.flatMap((cost) => cost.missingReasons))];
  if (costGroups.length === 0) missingReasons.push("model-cost-telemetry-missing");
  if (currencies.size > 1) missingReasons.push("multiple-currencies");
  if (!metrics.coverageComplete) missingReasons.push(...metrics.coverageMissingReasons);
  const kinds = new Set(costGroups.map((cost) => cost.kind));
  const single = costGroups.length === 1 ? costGroups[0] : undefined;
  const count = (value: number): MeasuredValue => ({
    value,
    complete: metrics.coverageComplete,
    missingReasons: metrics.coverageMissingReasons,
  });
  return {
    approvalWaitMs: count(metrics.approvalWaitMs),
    modelCalls: count(metrics.modelCalls),
    modelAttempts: {
      ...count(metrics.modelAttempts),
      complete: metrics.coverageComplete && metrics.modelAttemptsComplete,
      missingReasons: [
        ...metrics.coverageMissingReasons,
        ...(metrics.modelAttemptsComplete ? [] : ["native-compaction-attempt-count-unavailable"]),
      ],
    },
    retryWaitMs: count(metrics.retryWaitMs),
    toolCalls: count(metrics.toolCalls),
    toolFailures: count(metrics.toolFailures),
    contextCompactions: count(metrics.contextCompactions),
    humanInterventions: count(metrics.humanInterventions),
    totalTokens: {
      ...omitUndefined({ value: metrics.tokens.totalTokens }),
      complete: metrics.tokens.complete,
      missingReasons: metrics.tokens.missingReasons,
    },
    cost: {
      ...(known.length === 0 || currencies.size !== 1
        ? {}
        : { amount: known.reduce((sum, cost) => sum + cost.amount!, 0) }),
      currency: currencies.size === 1 ? costGroups[0]!.currency : "USD",
      kind: kinds.size === 1 ? costGroups[0]!.kind : "estimated",
      complete,
      missingReasons,
      ...omitUndefined({
        pricingId: single?.pricingId,
        pricingVersion: single?.pricingVersion,
        source: single?.source,
        effectiveAt: single?.effectiveAt,
      }),
    },
  };
}

/** @experimental */
export function createEvalTaskAssessment(options: {
  readonly trialId: string;
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly verdict: TaskAssessment["result"];
  readonly configurationVersion?: string;
  readonly identities?: EvalAgentIdentities;
  readonly evidenceReferences?: readonly string[];
  readonly timestamp?: number;
}): TaskAssessment {
  const identities = options.identities;
  const only = (values: readonly string[] | undefined) => (values?.length === 1 ? values[0] : undefined);
  return {
    taskId: only(identities?.taskIds) ?? options.trialId,
    evaluator: options.evaluatorId,
    evaluatorVersion: options.evaluatorVersion,
    result: options.verdict,
    ...omitUndefined({
      configurationVersion: options.configurationVersion,
      sessionId: only(identities?.sessionIds),
      runId: only(identities?.runIds),
      coordinationId: only(identities?.coordinationIds),
      traceId: only(identities?.traceIds),
    }),
    ...(options.evidenceReferences === undefined ? {} : { evidenceReferences: [...options.evidenceReferences] }),
    timestamp: options.timestamp ?? Date.now(),
  };
}
