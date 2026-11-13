import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { EvalRegistry } from "./registry.js";
import { createEvalReport, type EvalReport } from "./report.js";
import { createEvidenceSink, errorRecord, sanitizeEvent, sanitizeState, scopedSink } from "./trial-evidence.js";
import { executeTrial } from "./trial-execution.js";
import { MetricsAccumulator, measured, mergeMetrics } from "./trial-metrics.js";
import { addError, applyRevision, now, timed, validateResult } from "./trial-state.js";
import {
  createEvalPlan,
  validateExperiment,
  trialFingerprints,
  fingerprint,
  serializableExperiment,
} from "./validation.js";
import type {
  EvalExperiment,
  EvalPlan,
  EvalRunnerOptions,
  EvalStore,
  EvalTrial,
  EvaluationResult,
  EvidenceSink,
  TrialState,
} from "./types.js";

/** @experimental */
export class EvalRunner {
  private readonly registry: EvalRegistry;
  private readonly store: EvalStore;
  constructor(private readonly options: EvalRunnerOptions) {
    this.registry = options.registry;
    this.store = options.store;
  }
  validate(experiment: EvalExperiment): void {
    validateExperiment(experiment, this.registry);
  }
  async run(experiment: EvalExperiment): Promise<EvalReport> {
    this.validate(experiment);
    const release = await this.store.acquire(experiment.id);
    try {
      const plan = createEvalPlan(experiment);
      await this.store.createPlan(plan);
      await this.executePlan(plan, experiment);
      return createEvalReport(plan, await this.store.listTrials(experiment.id));
    } finally {
      await release();
    }
  }
  async resume(experimentId: string, runtimeExperiment?: EvalExperiment): Promise<EvalReport> {
    const release = await this.store.acquire(experimentId);
    try {
      const plan = await this.store.readPlan(experimentId);
      const experiment = this.runtimeExperiment(plan, runtimeExperiment);
      this.validate(experiment);
      for (const original of await this.store.listTrials(experimentId)) {
        if (original.endedAt !== undefined) continue;
        let state: TrialState = {
          ...original,
          executionStatus: "interrupted",
          taskVerdict: "not-evaluated",
          infrastructureStatus: "interrupted",
          endedAt: now(),
          awaitingReview: false,
          phases: original.phases.map((value) =>
            value.status === "running"
              ? {
                  ...value,
                  endedAt: now(),
                  status: "failed" as const,
                  error: {
                    phase: value.phase,
                    code: "process-interrupted",
                    name: "InterruptedError",
                    message: "The experiment stopped before this phase completed",
                  },
                }
              : value,
          ),
        };
        await this.store.writeTrial(experimentId, sanitizeState(state, experiment.evidencePolicy?.redact));
        const item = plan.experiment.cases.find((value) => value.id === original.trial.caseId)!;
        const variant = plan.experiment.variants.find((value) => value.id === original.trial.variantId)!;
        const adapter = this.registry.environment(item.environment);
        let confirmed = !original.phases.some((value) => value.phase === "execute");
        if (!confirmed) {
          const executionAdapter = this.registry.execution(variant.execution);
          if (executionAdapter.recover !== undefined) {
            try {
              confirmed = (
                await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, (signal) =>
                  executionAdapter.recover!({ state: original, case: item, variant, signal }),
                )
              ).confirmed;
            } catch (error) {
              state = addError(state, errorRecord("cleanup", error));
            }
          }
        }
        if (!confirmed) {
          state = addError(state, {
            phase: "cleanup",
            code: "termination-unconfirmed",
            name: "RecoveryError",
            message: "The interrupted execution must be confirmed terminated by its host before environment cleanup",
          });
        } else if (adapter.recover === undefined) {
          state = addError(state, {
            phase: "cleanup",
            code: "recovery-unavailable",
            name: "RecoveryError",
            message: "Environment recovery must be performed by its host",
          });
        } else {
          try {
            await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, (signal) =>
              adapter.recover!({
                trial: original.trial,
                case: item,
                variant,
                options: item.environment.options ?? {},
                signal,
              }),
            );
          } catch (error) {
            state = addError(state, errorRecord("cleanup", error));
          }
        }
        await this.store.writeTrial(experimentId, sanitizeState(state, experiment.evidencePolicy?.redact));
      }
      await this.executePlan(plan, experiment);
      return createEvalReport(plan, await this.store.listTrials(experimentId));
    } finally {
      await release();
    }
  }
  async retry(experimentId: string, trialId: string, runtimeExperiment?: EvalExperiment): Promise<EvalReport> {
    const release = await this.store.acquire(experimentId);
    try {
      const plan = await this.store.readPlan(experimentId);
      const experiment = this.runtimeExperiment(plan, runtimeExperiment);
      this.validate(experiment);
      const original = await this.store.readTrial(experimentId, trialId);
      if (original === undefined || original.endedAt === undefined)
        throw new Error("Only a finished trial can be retried");
      const trial: EvalTrial = {
        ...original.trial,
        id: `retry-${randomUUID()}`,
        ordinal: plan.trials.length,
        retryOf: trialId,
      };
      await this.store.appendTrial(experimentId, trial, trialFingerprints(plan.experiment, trial));
      await executeTrial(this.trialExecutionContext(), trial, experiment);
      const next = await this.store.readPlan(experimentId);
      return createEvalReport(next, await this.store.listTrials(experimentId));
    } finally {
      await release();
    }
  }
  async grade(
    experimentId: string,
    trialId: string,
    evaluatorId: string,
    result: EvaluationResult,
    runtimeExperiment?: EvalExperiment,
  ): Promise<TrialState> {
    validateResult(result);
    const release = await this.store.acquire(experimentId);
    try {
      const plan = await this.store.readPlan(experimentId);
      const experiment = this.runtimeExperiment(plan, runtimeExperiment);
      const state = await this.finishedTrial(experimentId, trialId);
      const item = plan.experiment.cases.find((value) => value.id === state.trial.caseId)!;
      const reference = item.evaluators.find((value) => value.id === evaluatorId);
      if (reference === undefined) throw new Error("Evaluator is not part of this case");
      const latest = state.evaluations.filter((value) => value.evaluatorId === evaluatorId).at(-1);
      if (
        !state.evaluations.some(
          (value) => value.evaluatorId === evaluatorId && value.result.verdict === "awaiting-review",
        )
      )
        throw new Error("Manual grading requires an evaluator awaiting review");
      const next = sanitizeState(
        applyRevision(
          state,
          {
            evaluatorId,
            evaluatorVersion: reference.version,
            required: reference.required,
            revision: (latest?.revision ?? 0) + 1,
            createdAt: now(),
            result,
          },
          item,
        ),
        experiment.evidencePolicy?.redact,
      );
      await this.store.writeTrial(experimentId, next);
      return next;
    } finally {
      await release();
    }
  }
  async evaluateTrial(
    experimentId: string,
    trialId: string,
    evaluatorId: string,
    runtimeExperiment?: EvalExperiment,
  ): Promise<TrialState> {
    const release = await this.store.acquire(experimentId);
    let pending: Promise<EvaluationResult> | undefined;
    let acceptingWrites = true;
    try {
      const plan = await this.store.readPlan(experimentId);
      const experiment = this.runtimeExperiment(plan, runtimeExperiment);
      const state = await this.finishedTrial(experimentId, trialId);
      const item = plan.experiment.cases.find((value) => value.id === state.trial.caseId)!;
      const variant = plan.experiment.variants.find((value) => value.id === state.trial.variantId)!;
      const reference = item.evaluators.find((value) => value.id === evaluatorId);
      if (reference === undefined || state.evaluationTarget === undefined || state.execution === undefined)
        throw new Error("Trial has no retained evaluation target");
      const revision =
        (state.evaluations.filter((value) => value.evaluatorId === evaluatorId).at(-1)?.revision ?? 0) + 1;
      const metrics = new MetricsAccumulator(variant, item);
      const evidence = [...state.evidence];
      const originalSink = createEvidenceSink(this.store, experiment, state.trial, evidence);
      const sink: EvidenceSink = {
        write: (value) => {
          if (!acceptingWrites) throw new Error("The evaluation evidence writer has closed");
          return originalSink.write(value);
        },
      };
      const evaluationStarted = performance.now();
      try {
        const result = await timed("evaluate", item.limits.evaluationTimeoutMs, this.options.signal, (signal) => {
          pending = this.registry.evaluator(reference).evaluate(
            {
              trial: state.trial,
              case: item,
              variant,
              options: reference.options ?? {},
              target: state.evaluationTarget!,
              execution: state.execution!,
              evidenceSink: scopedSink(sink, `${evaluatorId}:${revision}`),
              emit: async (event) => {
                if (!acceptingWrites) throw new Error("The evaluation telemetry writer has closed");
                const saved = sanitizeEvent({
                  ...event,
                  scope: "grader",
                  id: `${evaluatorId}:${revision}:${event.id}`,
                });
                metrics.record(saved);
                await this.store.appendEvent(experimentId, trialId, saved);
              },
            },
            signal,
          );
          return pending;
        });
        validateResult(result);
        const next = applyRevision(
          {
            ...state,
            evidence,
            graderMetrics: mergeMetrics(state.graderMetrics, {
              ...metrics.snapshot(),
              ...result.metrics,
              durationMs: measured(performance.now() - evaluationStarted),
            }),
          },
          {
            evaluatorId,
            evaluatorVersion: reference.version,
            required: reference.required,
            revision,
            createdAt: now(),
            result,
          },
          item,
        );
        const saved = sanitizeState(next, experiment.evidencePolicy?.redact);
        await this.store.writeTrial(experimentId, saved);
        return saved;
      } catch (error) {
        let retained = addError(state, errorRecord("evaluate", error));
        let lateResult: EvaluationResult | undefined;
        if (pending !== undefined) {
          try {
            await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, async () => {
              lateResult = await pending!.catch(() => undefined);
            });
          } catch (cleanupError) {
            retained = addError(retained, errorRecord("cleanup", cleanupError));
          }
        }
        acceptingWrites = false;
        retained = {
          ...retained,
          evidence,
          graderMetrics: mergeMetrics(state.graderMetrics, {
            ...metrics.snapshot(),
            ...lateResult?.metrics,
            durationMs: measured(performance.now() - evaluationStarted),
          }),
        };
        await this.store.writeTrial(experimentId, sanitizeState(retained, experiment.evidencePolicy?.redact));
        throw error;
      }
    } finally {
      acceptingWrites = false;
      await release();
    }
  }
  private async finishedTrial(experimentId: string, trialId: string): Promise<TrialState> {
    const state = await this.store.readTrial(experimentId, trialId);
    if (state === undefined || state.endedAt === undefined) throw new Error("Trial has not completed");
    return state;
  }
  private runtimeExperiment(plan: EvalPlan, runtime?: EvalExperiment): EvalExperiment {
    if (runtime !== undefined && fingerprint(serializableExperiment(runtime)) !== fingerprint(plan.experiment))
      throw new Error("Runtime experiment configuration differs from the stored plan");
    const experiment = runtime ?? plan.experiment;
    if (experiment.evidencePolicy?.redactorId !== undefined && experiment.evidencePolicy.redact === undefined)
      throw new Error("Restore the registered evidence redactor before continuing this experiment");
    return experiment;
  }
  private async executePlan(plan: EvalPlan, experiment: EvalExperiment): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (cursor < plan.trials.length && !this.options.signal?.aborted) {
        const trial = plan.trials[cursor++]!;
        if ((await this.store.readTrial(experiment.id, trial.id)) === undefined)
          await executeTrial(this.trialExecutionContext(), trial, experiment);
      }
    };
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(experiment.concurrency, plan.trials.length) }, worker),
    );
    const failure = results.find((value): value is PromiseRejectedResult => value.status === "rejected");
    if (failure !== undefined) throw failure.reason;
  }
  private trialExecutionContext(): Parameters<typeof executeTrial>[0] {
    return { registry: this.registry, store: this.store, options: this.options };
  }
}
