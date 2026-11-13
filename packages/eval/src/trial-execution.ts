import { performance } from "node:perf_hooks";
import { resolveRunBudget } from "@sortedyuan/may/core";
import type { EvalRegistry } from "./registry.js";
import {
  createEvidenceSink,
  errorRecord,
  redact,
  redactJson,
  sanitizeEvent,
  sanitizeState,
  scopedSink,
} from "./trial-evidence.js";
import { MetricsAccumulator, addMetricOverrides, measured } from "./trial-metrics.js";
import { addError, applyRevision, now, timed, validateResult } from "./trial-state.js";
import { assertJson } from "./validation.js";
import type {
  EvalExecution,
  EvalExecutionEvent,
  EvalExecutionResult,
  EvalExperiment,
  EvalMetrics,
  EvalPhase,
  EvalRunnerOptions,
  EvalStore,
  EvalTrial,
  EvaluationResult,
  EvaluationTarget,
  EvidenceReference,
  EvidenceSink,
  PreparedEnvironment,
  TrialState,
} from "./types.js";

export async function executeTrial(
  {
    registry,
    store,
    options,
  }: { readonly registry: EvalRegistry; readonly store: EvalStore; readonly options: EvalRunnerOptions },
  trial: EvalTrial,
  experiment: EvalExperiment,
): Promise<void> {
  const item = experiment.cases.find((value) => value.id === trial.caseId)!;
  const variant = experiment.variants.find((value) => value.id === trial.variantId)!;
  const environmentAdapter = registry.environment(item.environment);
  const metrics = new MetricsAccumulator(variant, item);
  const grader = new MetricsAccumulator(variant, item);
  const evidence: EvidenceReference[] = [];
  let acceptingWrites = true;
  const originalSink = createEvidenceSink(store, experiment, trial, evidence);
  const sink: EvidenceSink = {
    write: (value) => {
      if (!acceptingWrites) throw new Error("The trial evidence writer has closed");
      return originalSink.write(value);
    },
  };
  let state: TrialState = {
    trial,
    phases: [],
    startedAt: now(),
    taskVerdict: "not-evaluated",
    infrastructureStatus: "ready",
    errors: [],
    evaluations: [],
    metrics: metrics.snapshot(),
    graderMetrics: grader.snapshot(),
    evidence,
    awaitingReview: false,
  };
  let environment: PreparedEnvironment | undefined;
  let execution: EvalExecution | undefined;
  let terminationConfirmed = true;
  let resultMetrics: Partial<EvalMetrics> | undefined;
  let gradingMetrics: Partial<EvalMetrics> | undefined;
  let pendingPrepare: Promise<PreparedEnvironment> | undefined;
  let pendingCreate: Promise<EvalExecution> | undefined;
  let pendingExecute: Promise<EvalExecutionResult> | undefined;
  let pendingEvaluation: Promise<EvaluationResult> | undefined;
  let pendingFreeze: Promise<EvaluationTarget> | undefined;
  let pendingEvaluationApplied = true;
  const evaluateTracked = (operation: () => Promise<EvaluationResult>) => {
    pendingEvaluationApplied = false;
    pendingEvaluation = Promise.resolve()
      .then(operation)
      .catch((error) => {
        if (errorRecord("evaluate", error).code === "termination-unconfirmed") terminationConfirmed = false;
        throw error;
      });
    return pendingEvaluation;
  };
  let result: EvalExecutionResult | undefined;
  let currentPhase: EvalPhase = "prepare";
  const save = async () => {
    state = sanitizeState(
      {
        ...state,
        metrics: { ...metrics.snapshot(state.metrics), ...resultMetrics },
        graderMetrics: { ...grader.snapshot(state.graderMetrics), ...gradingMetrics },
        evidence: [...evidence],
      },
      experiment.evidencePolicy?.redact,
    );
    await store.writeTrial(experiment.id, state);
  };
  const emit = async (event: EvalExecutionEvent) => {
    if (!acceptingWrites) throw new Error("The trial telemetry writer has closed");
    const saved = sanitizeEvent(event);
    (saved.scope === "grader" ? grader : metrics).record(saved);
    await store.appendEvent(experiment.id, trial.id, saved);
  };
  const phase = async <T>(
    name: EvalPhase,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>,
    useOuterSignal = true,
  ): Promise<T> => {
    currentPhase = name;
    const started = performance.now();
    const record = { phase: name, startedAt: now(), status: "running" as const };
    state = { ...state, phases: [...state.phases, record] };
    await save();
    try {
      const value = await timed(name, timeoutMs, useOuterSignal ? options.signal : undefined, operation);
      state = {
        ...state,
        phases: [
          ...state.phases.slice(0, -1),
          { ...record, endedAt: now(), durationMs: performance.now() - started, status: "completed" },
        ],
      };
      await save();
      return value;
    } catch (error) {
      const reason = errorRecord(name, error);
      state = {
        ...state,
        phases: [
          ...state.phases.slice(0, -1),
          {
            ...record,
            endedAt: now(),
            durationMs: performance.now() - started,
            status:
              reason.code === "phase-timeout"
                ? "limited"
                : options.signal?.aborted && useOuterSignal
                  ? "cancelled"
                  : "failed",
            error: reason,
          },
        ],
      };
      await save();
      throw error;
    }
  };
  try {
    environment = await phase("prepare", item.limits.prepareTimeoutMs, (signal) => {
      pendingPrepare = environmentAdapter
        .prepare({ trial, case: item, variant, options: item.environment.options ?? {}, signal })
        .then(async (prepared) => {
          if (signal.aborted) {
            await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, (cleanupSignal) =>
              prepared.dispose(cleanupSignal),
            );
            signal.throwIfAborted();
          }
          return prepared;
        });
      return pendingPrepare;
    });
    state = { ...state, environmentId: environment.id };
    for (const [key, required] of Object.entries(item.requiredCapabilities ?? {}))
      if (required && !environment.capabilities[key as keyof typeof environment.capabilities])
        throw new Error(`Prepared environment does not provide ${key}`);
    if (experiment.concurrency > 1 && !environment.capabilities.independentResources)
      throw new Error("Prepared environment cannot run independent concurrent trials");
    const runBudget = resolveRunBudget(item.limits.runBudget, variant.runBudget);
    result = await phase(
      "execute",
      Math.min(item.limits.executionTimeoutMs, runBudget.maxDurationMs ?? item.limits.executionTimeoutMs),
      async (signal) => {
        terminationConfirmed = false;
        pendingCreate = registry
          .execution(variant.execution)
          .create({
            trial,
            case: item,
            variant,
            options: variant.execution.options ?? {},
            target: environment!.executionTarget,
            runBudget: resolveRunBudget(item.limits.runBudget, variant.runBudget),
            evidenceSink: sink,
            emit,
            signal,
          })
          .then(async (created) => {
            if (signal.aborted) {
              await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, (cleanupSignal) =>
                created.close(cleanupSignal),
              );
              signal.throwIfAborted();
            }
            return created;
          });
        const created = await pendingCreate;
        execution = created;
        pendingExecute = created.execute(signal);
        const outcome = await pendingExecute;
        assertJson(outcome);
        if (
          !["completed", "failed", "limited", "cancelled"].includes(outcome.status) ||
          typeof outcome.terminationConfirmed !== "boolean"
        )
          throw new TypeError("Invalid execution result");
        return outcome;
      },
    );
    terminationConfirmed = result.terminationConfirmed;
    const { output, ...executionMetadata } = result;
    const retainedOutput =
      output === undefined || experiment.evidencePolicy?.retainContent !== true
        ? undefined
        : redactJson(output, experiment.evidencePolicy.redact);
    if (retainedOutput !== undefined)
      await sink.write({
        id: "execution-output",
        mediaType: "application/json",
        content: JSON.stringify(retainedOutput),
      });
    state = {
      ...state,
      executionStatus: result.status,
      execution: {
        ...executionMetadata,
        ...(executionMetadata.reason === undefined ? {} : { reason: redact(executionMetadata.reason).slice(0, 4096) }),
        ...(retainedOutput === undefined ? {} : { output: retainedOutput }),
      },
      metrics: { ...state.metrics, ...result.metrics },
    };
    resultMetrics = result.metrics;
    if (!terminationConfirmed)
      throw Object.assign(new Error("Execution termination could not be confirmed"), {
        code: "termination-unconfirmed",
      });
    if (result.status !== "cancelled" && (result.status !== "limited" || item.evaluateAfterLimit === true)) {
      const target = await phase("freeze", item.limits.evaluationTimeoutMs, (signal) => {
        pendingFreeze = environment!.freeze(signal);
        return pendingFreeze;
      });
      state = { ...state, evaluationTarget: target };
      await phase("evaluate", item.limits.evaluationTimeoutMs, async (signal) => {
        for (const reference of item.evaluators) {
          const evaluator = registry.evaluator(reference);
          let evaluation: EvaluationResult;
          try {
            evaluation = await evaluateTracked(() =>
              evaluator.evaluate(
                {
                  trial,
                  case: item,
                  variant,
                  options: reference.options ?? {},
                  target,
                  execution: result!,
                  evidenceSink: scopedSink(sink, `${reference.id}:1`),
                  emit: (event) => emit({ ...event, scope: "grader", id: `${reference.id}:1:${event.id}` }),
                },
                signal,
              ),
            );
            signal.throwIfAborted();
            validateResult(evaluation);
          } catch (error) {
            if (signal.aborted || !terminationConfirmed) throw error;
            state = { ...addError(state, errorRecord("evaluate", error)), infrastructureStatus: "failed" };
            evaluation = { verdict: "inconclusive", checks: [], evidence: [] };
          }
          state = applyRevision(
            state,
            {
              evaluatorId: reference.id,
              evaluatorVersion: reference.version,
              required: reference.required,
              revision: 1,
              createdAt: now(),
              result: evaluation,
            },
            item,
          );
          if (evaluation.metrics !== undefined) gradingMetrics = addMetricOverrides(gradingMetrics, evaluation.metrics);
          pendingEvaluationApplied = true;
          signal.throwIfAborted();
          await save();
        }
      });
    }
  } catch (error) {
    const reason = errorRecord(currentPhase, error);
    state = addError(state, reason);
    if ((currentPhase as EvalPhase) === "execute") {
      const status = reason.code === "phase-timeout" ? "limited" : options.signal?.aborted ? "cancelled" : "failed";
      state = { ...state, executionStatus: status };
      if (execution !== undefined) {
        try {
          terminationConfirmed = (
            await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, (signal) => execution!.cancel(signal))
          ).confirmed;
        } catch (cancelError) {
          terminationConfirmed = false;
          state = addError(state, errorRecord("cleanup", cancelError));
        }
      }
      if (!terminationConfirmed)
        state = addError(state, {
          phase: "cleanup",
          code: "termination-unconfirmed",
          name: "TerminationError",
          message: "Execution termination could not be confirmed; its environment is retained",
        });
      if (
        status === "limited" &&
        terminationConfirmed &&
        item.evaluateAfterLimit === true &&
        environment !== undefined
      ) {
        try {
          const target = await phase(
            "freeze",
            item.limits.evaluationTimeoutMs,
            (signal) => {
              pendingFreeze = environment!.freeze(signal);
              return pendingFreeze;
            },
            false,
          );
          const partial: EvalExecutionResult = { status, terminationConfirmed, reason: reason.code };
          state = { ...state, execution: partial, evaluationTarget: target };
          await phase(
            "evaluate",
            item.limits.evaluationTimeoutMs,
            async (signal) => {
              for (const reference of item.evaluators) {
                const evaluation = await evaluateTracked(() =>
                  registry.evaluator(reference).evaluate(
                    {
                      trial,
                      case: item,
                      variant,
                      options: reference.options ?? {},
                      target,
                      execution: partial,
                      evidenceSink: scopedSink(sink, `${reference.id}:1`),
                      emit: (event) => emit({ ...event, scope: "grader", id: `${reference.id}:1:${event.id}` }),
                    },
                    signal,
                  ),
                );
                signal.throwIfAborted();
                validateResult(evaluation);
                state = applyRevision(
                  state,
                  {
                    evaluatorId: reference.id,
                    evaluatorVersion: reference.version,
                    required: reference.required,
                    revision: 1,
                    createdAt: now(),
                    result: evaluation,
                  },
                  item,
                );
                if (evaluation.metrics !== undefined)
                  gradingMetrics = addMetricOverrides(gradingMetrics, evaluation.metrics);
                pendingEvaluationApplied = true;
              }
            },
            false,
          );
        } catch (evaluationError) {
          state = addError(state, errorRecord(currentPhase, evaluationError));
        }
      }
    } else state = { ...state, infrastructureStatus: "failed" };
  } finally {
    try {
      await phase(
        "cleanup",
        item.limits.cleanupTimeoutMs,
        async (signal) => {
          if (pendingPrepare !== undefined && environment === undefined)
            await pendingPrepare.then(
              () => undefined,
              () => undefined,
            );
          if (pendingCreate !== undefined && execution === undefined)
            await pendingCreate.then(
              () => undefined,
              () => undefined,
            );
          if (pendingFreeze !== undefined)
            await pendingFreeze.then(
              () => undefined,
              () => undefined,
            );
          if (pendingEvaluation !== undefined)
            await pendingEvaluation.then(
              (evaluation) => {
                if (!pendingEvaluationApplied && evaluation.metrics !== undefined)
                  gradingMetrics = addMetricOverrides(gradingMetrics, evaluation.metrics);
              },
              () => undefined,
            );
          signal.throwIfAborted();
          if (execution !== undefined) await execution.close(signal);
          if (pendingExecute !== undefined)
            await pendingExecute.then(
              async (outcome) => {
                if (result !== undefined) return;
                assertJson(outcome as unknown);
                resultMetrics = outcome.metrics;
                const { output, ...metadata } = outcome;
                const retainedOutput =
                  output === undefined || experiment.evidencePolicy?.retainContent !== true
                    ? undefined
                    : redactJson(output, experiment.evidencePolicy.redact);
                if (retainedOutput !== undefined)
                  await sink.write({
                    id: "execution-output",
                    mediaType: "application/json",
                    content: JSON.stringify(retainedOutput),
                  });
                state = {
                  ...state,
                  execution: {
                    ...metadata,
                    ...(metadata.reason === undefined ? {} : { reason: redact(metadata.reason).slice(0, 4096) }),
                    ...(retainedOutput === undefined ? {} : { output: retainedOutput }),
                  },
                };
              },
              () => undefined,
            );
          signal.throwIfAborted();
          if (environment !== undefined && terminationConfirmed) await environment.dispose(signal);
          else if (
            environment === undefined &&
            pendingPrepare !== undefined &&
            environmentAdapter.recover !== undefined
          )
            await environmentAdapter.recover({
              trial,
              case: item,
              variant,
              options: item.environment.options ?? {},
              signal,
            });
        },
        false,
      );
    } catch (error) {
      state = { ...addError(state, errorRecord("cleanup", error)), infrastructureStatus: "failed" };
    }
    const elapsed = state.phases.find((value) => value.phase === "execute")?.durationMs;
    const evaluationDurations = state.phases
      .filter((value) => value.phase === "evaluate" && value.durationMs !== undefined)
      .map((value) => value.durationMs!);
    if (evaluationDurations.length > 0)
      gradingMetrics = {
        ...gradingMetrics,
        durationMs: measured(evaluationDurations.reduce((sum, value) => sum + value, 0)),
      };
    state = {
      ...state,
      endedAt: now(),
      ...(state.executionStatus === undefined
        ? { executionStatus: options.signal?.aborted ? ("cancelled" as const) : ("failed" as const) }
        : {}),
      metrics: { ...state.metrics, ...(elapsed === undefined ? {} : { durationMs: measured(elapsed) }) },
    };
    if (resultMetrics !== undefined && elapsed !== undefined)
      resultMetrics = { ...resultMetrics, durationMs: measured(elapsed) };
    acceptingWrites = false;
    await save();
    await options.onTrial?.(state);
  }
}
