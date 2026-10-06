import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { aggregateUsage, priceUsage, resolveRunBudget, resolveUsageTotals, validateUsageCost, type Usage, type UsageCost } from "@may/core";
import type { EvalRegistry } from "./registry.js";
import { createEvalReport, type EvalReport } from "./report.js";
import { assertJson, createEvalPlan, DEFAULT_EVIDENCE_POLICY, validateExperiment, trialFingerprints, fingerprint, serializableExperiment } from "./validation.js";
import type { EvalCase, EvalError, EvalExecution, EvalExecutionEvent, EvalExecutionResult, EvalExperiment, EvalLimits, EvalMetrics, EvalPhase, EvalPlan, EvalRunnerOptions, EvalStore, EvalTrial, EvalVariant, EvaluationResult, EvaluationRevision, EvaluationTarget, EvidencePolicy, EvidenceReference, EvidenceSink, MeasuredValue, PreparedEnvironment, TaskVerdict, TrialState } from "./types.js";

class PhaseLimitError extends Error { readonly code = "phase-timeout"; constructor(readonly phase: EvalPhase) { super(`${phase} exceeded its timeout`); this.name = "PhaseLimitError"; } }
export class EvalRunner {
  private readonly registry: EvalRegistry;
  private readonly store: EvalStore;
  constructor(private readonly options: EvalRunnerOptions) { this.registry = options.registry; this.store = options.store; }
  validate(experiment: EvalExperiment): void { validateExperiment(experiment, this.registry); }
  async run(experiment: EvalExperiment): Promise<EvalReport> {
    this.validate(experiment);
    const release = await this.store.acquire(experiment.id);
    try { const plan = createEvalPlan(experiment); await this.store.createPlan(plan); await this.executePlan(plan, experiment); return createEvalReport(plan, await this.store.listTrials(experiment.id)); } finally { await release(); }
  }
  async resume(experimentId: string, runtimeExperiment?: EvalExperiment): Promise<EvalReport> {
    const release = await this.store.acquire(experimentId);
    try {
      const plan = await this.store.readPlan(experimentId); const experiment = this.runtimeExperiment(plan, runtimeExperiment); this.validate(experiment);
      for (const original of await this.store.listTrials(experimentId)) {
        if (original.endedAt !== undefined) continue;
        let state: TrialState = { ...original, executionStatus: "interrupted", taskVerdict: "not-evaluated", infrastructureStatus: "interrupted", endedAt: now(), awaitingReview: false,
          phases: original.phases.map(value => value.status === "running" ? { ...value, endedAt: now(), status: "failed" as const, error: { phase: value.phase, code: "process-interrupted", name: "InterruptedError", message: "The experiment stopped before this phase completed" } } : value) };
        await this.store.writeTrial(experimentId, sanitizeState(state, experiment.evidencePolicy?.redact));
        const item = plan.experiment.cases.find(value => value.id === original.trial.caseId)!;
        const variant = plan.experiment.variants.find(value => value.id === original.trial.variantId)!;
        const adapter = this.registry.environment(item.environment);
        let confirmed = !original.phases.some(value => value.phase === "execute");
        if (!confirmed) {
          const executionAdapter = this.registry.execution(variant.execution);
          if (executionAdapter.recover !== undefined) {
            try { confirmed = (await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, signal => executionAdapter.recover!({ state: original, case: item, variant, signal }))).confirmed; }
            catch (error) { state = addError(state, errorRecord("cleanup", error)); }
          }
        }
        if (!confirmed) {
          state = addError(state, { phase: "cleanup", code: "termination-unconfirmed", name: "RecoveryError", message: "The interrupted execution must be confirmed terminated by its host before environment cleanup" });
        } else if (adapter.recover === undefined) {
          state = addError(state, { phase: "cleanup", code: "recovery-unavailable", name: "RecoveryError", message: "Environment recovery must be performed by its host" });
        } else {
          try { await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, signal => adapter.recover!({ trial: original.trial, case: item, variant, options: item.environment.options ?? {}, signal })); }
          catch (error) { state = addError(state, errorRecord("cleanup", error)); }
        }
        await this.store.writeTrial(experimentId, sanitizeState(state, experiment.evidencePolicy?.redact));
      }
      await this.executePlan(plan, experiment);
      return createEvalReport(plan, await this.store.listTrials(experimentId));
    } finally { await release(); }
  }
  async retry(experimentId: string, trialId: string, runtimeExperiment?: EvalExperiment): Promise<EvalReport> {
    const release = await this.store.acquire(experimentId);
    try {
      const plan = await this.store.readPlan(experimentId); const experiment = this.runtimeExperiment(plan, runtimeExperiment); this.validate(experiment);
      const original = await this.store.readTrial(experimentId, trialId);
      if (original === undefined || original.endedAt === undefined) throw new Error("Only a finished trial can be retried");
      const trial: EvalTrial = { ...original.trial, id: `retry-${randomUUID()}`, ordinal: plan.trials.length, retryOf: trialId };
      await this.store.appendTrial(experimentId, trial, trialFingerprints(plan.experiment, trial));
      await this.executeTrial(trial, experiment);
      const next = await this.store.readPlan(experimentId);
      return createEvalReport(next, await this.store.listTrials(experimentId));
    } finally { await release(); }
  }
  async grade(experimentId: string, trialId: string, evaluatorId: string, result: EvaluationResult, runtimeExperiment?: EvalExperiment): Promise<TrialState> {
    validateResult(result);
    const release = await this.store.acquire(experimentId);
    try {
      const plan = await this.store.readPlan(experimentId); const experiment = this.runtimeExperiment(plan, runtimeExperiment); const state = await this.finishedTrial(experimentId, trialId);
      const item = plan.experiment.cases.find(value => value.id === state.trial.caseId)!;
      const reference = item.evaluators.find(value => value.id === evaluatorId);
      if (reference === undefined) throw new Error("Evaluator is not part of this case");
      const latest = state.evaluations.filter(value => value.evaluatorId === evaluatorId).at(-1);
      if (!state.evaluations.some(value => value.evaluatorId === evaluatorId && value.result.verdict === "awaiting-review")) throw new Error("Manual grading requires an evaluator awaiting review");
      const next = sanitizeState(applyRevision(state, { evaluatorId, evaluatorVersion: reference.version, required: reference.required, revision: (latest?.revision ?? 0) + 1, createdAt: now(), result }, item), experiment.evidencePolicy?.redact);
      await this.store.writeTrial(experimentId, next); return next;
    } finally { await release(); }
  }
  async evaluateTrial(experimentId: string, trialId: string, evaluatorId: string, runtimeExperiment?: EvalExperiment): Promise<TrialState> {
    const release = await this.store.acquire(experimentId);
    let pending: Promise<EvaluationResult> | undefined; let acceptingWrites = true;
    try {
      const plan = await this.store.readPlan(experimentId); const experiment = this.runtimeExperiment(plan, runtimeExperiment); const state = await this.finishedTrial(experimentId, trialId);
      const item = plan.experiment.cases.find(value => value.id === state.trial.caseId)!; const variant = plan.experiment.variants.find(value => value.id === state.trial.variantId)!;
      const reference = item.evaluators.find(value => value.id === evaluatorId);
      if (reference === undefined || state.evaluationTarget === undefined || state.execution === undefined) throw new Error("Trial has no retained evaluation target");
      const revision = (state.evaluations.filter(value => value.evaluatorId === evaluatorId).at(-1)?.revision ?? 0) + 1;
      const metrics = new MetricsAccumulator(variant, item); const evidence = [...state.evidence]; const originalSink = this.evidenceSink(experiment, state.trial, evidence);
      const sink: EvidenceSink = { write: value => { if (!acceptingWrites) throw new Error("The evaluation evidence writer has closed"); return originalSink.write(value); } };
      const evaluationStarted = performance.now();
      try {
        const result = await timed("evaluate", item.limits.evaluationTimeoutMs, this.options.signal, signal => {
          pending = this.registry.evaluator(reference).evaluate({ trial: state.trial, case: item, variant, options: reference.options ?? {}, target: state.evaluationTarget!, execution: state.execution!, evidenceSink: scopedSink(sink, `${evaluatorId}:${revision}`),
            emit: async event => { if (!acceptingWrites) throw new Error("The evaluation telemetry writer has closed"); const saved = sanitizeEvent({ ...event, scope: "grader", id: `${evaluatorId}:${revision}:${event.id}` }); metrics.record(saved); await this.store.appendEvent(experimentId, trialId, saved); } }, signal); return pending;
        });
        validateResult(result);
        const next = applyRevision({ ...state, evidence, graderMetrics: mergeMetrics(state.graderMetrics, { ...metrics.snapshot(), ...result.metrics, durationMs: measured(performance.now() - evaluationStarted) }) }, { evaluatorId, evaluatorVersion: reference.version, required: reference.required, revision, createdAt: now(), result }, item);
        const saved = sanitizeState(next, experiment.evidencePolicy?.redact); await this.store.writeTrial(experimentId, saved); return saved;
      } catch (error) {
        let retained = addError(state, errorRecord("evaluate", error)); let lateResult: EvaluationResult | undefined;
        if (pending !== undefined) {
          try { await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, async () => { lateResult = await pending!.catch(() => undefined); }); }
          catch (cleanupError) { retained = addError(retained, errorRecord("cleanup", cleanupError)); }
        }
        acceptingWrites = false;
        retained = { ...retained, evidence, graderMetrics: mergeMetrics(state.graderMetrics, { ...metrics.snapshot(), ...lateResult?.metrics, durationMs: measured(performance.now() - evaluationStarted) }) };
        await this.store.writeTrial(experimentId, sanitizeState(retained, experiment.evidencePolicy?.redact)); throw error;
      }
    } finally { acceptingWrites = false; await release(); }
  }
  private async finishedTrial(experimentId: string, trialId: string): Promise<TrialState> { const state = await this.store.readTrial(experimentId, trialId); if (state === undefined || state.endedAt === undefined) throw new Error("Trial has not completed"); return state; }
  private runtimeExperiment(plan: EvalPlan, runtime?: EvalExperiment): EvalExperiment {
    if (runtime !== undefined && fingerprint(serializableExperiment(runtime)) !== fingerprint(plan.experiment)) throw new Error("Runtime experiment configuration differs from the stored plan");
    const experiment = runtime ?? plan.experiment;
    if (experiment.evidencePolicy?.redactorId !== undefined && experiment.evidencePolicy.redact === undefined) throw new Error("Restore the registered evidence redactor before continuing this experiment");
    return experiment;
  }
  private async executePlan(plan: EvalPlan, experiment: EvalExperiment): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (cursor < plan.trials.length && !this.options.signal?.aborted) {
        const trial = plan.trials[cursor++]!;
        if (await this.store.readTrial(experiment.id, trial.id) === undefined) await this.executeTrial(trial, experiment);
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(experiment.concurrency, plan.trials.length) }, worker));
    const failure = results.find((value): value is PromiseRejectedResult => value.status === "rejected"); if (failure !== undefined) throw failure.reason;
  }
  private async executeTrial(trial: EvalTrial, experiment: EvalExperiment): Promise<void> {
    const item = experiment.cases.find(value => value.id === trial.caseId)!; const variant = experiment.variants.find(value => value.id === trial.variantId)!;
    const environmentAdapter = this.registry.environment(item.environment);
    const metrics = new MetricsAccumulator(variant, item); const grader = new MetricsAccumulator(variant, item);
    const evidence: EvidenceReference[] = []; let acceptingWrites = true; const originalSink = this.evidenceSink(experiment, trial, evidence);
    const sink: EvidenceSink = { write: value => { if (!acceptingWrites) throw new Error("The trial evidence writer has closed"); return originalSink.write(value); } };
    let state: TrialState = { trial, phases: [], startedAt: now(), taskVerdict: "not-evaluated", infrastructureStatus: "ready", errors: [], evaluations: [], metrics: metrics.snapshot(), graderMetrics: grader.snapshot(), evidence, awaitingReview: false };
    let environment: PreparedEnvironment | undefined; let execution: EvalExecution | undefined; let terminationConfirmed = true; let resultMetrics: Partial<EvalMetrics> | undefined; let gradingMetrics: Partial<EvalMetrics> | undefined;
    let pendingPrepare: Promise<PreparedEnvironment> | undefined; let pendingCreate: Promise<EvalExecution> | undefined; let pendingExecute: Promise<EvalExecutionResult> | undefined; let pendingEvaluation: Promise<EvaluationResult> | undefined; let pendingFreeze: Promise<EvaluationTarget> | undefined;
    let pendingEvaluationApplied = true;
    const evaluateTracked = (operation: () => Promise<EvaluationResult>) => {
      pendingEvaluationApplied = false;
      pendingEvaluation = Promise.resolve().then(operation).catch(error => { if (errorRecord("evaluate", error).code === "termination-unconfirmed") terminationConfirmed = false; throw error; });
      return pendingEvaluation;
    };
    let result: EvalExecutionResult | undefined; let currentPhase: EvalPhase = "prepare";
    const save = async () => { state = sanitizeState({ ...state, metrics: { ...metrics.snapshot(state.metrics), ...resultMetrics }, graderMetrics: { ...grader.snapshot(state.graderMetrics), ...gradingMetrics }, evidence: [...evidence] }, experiment.evidencePolicy?.redact); await this.store.writeTrial(experiment.id, state); };
    const emit = async (event: EvalExecutionEvent) => { if (!acceptingWrites) throw new Error("The trial telemetry writer has closed"); const saved = sanitizeEvent(event); (saved.scope === "grader" ? grader : metrics).record(saved); await this.store.appendEvent(experiment.id, trial.id, saved); };
    const phase = async <T>(name: EvalPhase, timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>, useOuterSignal = true): Promise<T> => {
      currentPhase = name; const started = performance.now(); const record = { phase: name, startedAt: now(), status: "running" as const }; state = { ...state, phases: [...state.phases, record] }; await save();
      try { const value = await timed(name, timeoutMs, useOuterSignal ? this.options.signal : undefined, operation); state = { ...state, phases: [...state.phases.slice(0, -1), { ...record, endedAt: now(), durationMs: performance.now() - started, status: "completed" }] }; await save(); return value; }
      catch (error) { const reason = errorRecord(name, error); state = { ...state, phases: [...state.phases.slice(0, -1), { ...record, endedAt: now(), durationMs: performance.now() - started, status: reason.code === "phase-timeout" ? "limited" : this.options.signal?.aborted && useOuterSignal ? "cancelled" : "failed", error: reason }] }; await save(); throw error; }
    };
    try {
      environment = await phase("prepare", item.limits.prepareTimeoutMs, signal => {
        pendingPrepare = environmentAdapter.prepare({ trial, case: item, variant, options: item.environment.options ?? {}, signal }).then(async prepared => {
          if (signal.aborted) { await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, cleanupSignal => prepared.dispose(cleanupSignal)); signal.throwIfAborted(); }
          return prepared;
        }); return pendingPrepare;
      });
      state = { ...state, environmentId: environment.id };
      for (const [key, required] of Object.entries(item.requiredCapabilities ?? {})) if (required && !environment.capabilities[key as keyof typeof environment.capabilities]) throw new Error(`Prepared environment does not provide ${key}`);
      if (experiment.concurrency > 1 && !environment.capabilities.independentResources) throw new Error("Prepared environment cannot run independent concurrent trials");
      const runBudget = resolveRunBudget(item.limits.runBudget, variant.runBudget);
      result = await phase("execute", Math.min(item.limits.executionTimeoutMs, runBudget.maxDurationMs ?? item.limits.executionTimeoutMs), async signal => {
        terminationConfirmed = false;
        pendingCreate = this.registry.execution(variant.execution).create({ trial, case: item, variant, options: variant.execution.options ?? {}, target: environment!.executionTarget, runBudget: resolveRunBudget(item.limits.runBudget, variant.runBudget), evidenceSink: sink, emit, signal }).then(async created => {
          if (signal.aborted) { await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, cleanupSignal => created.close(cleanupSignal)); signal.throwIfAborted(); } return created;
        });
        const created = await pendingCreate;
        execution = created;
        pendingExecute = created.execute(signal); const outcome = await pendingExecute;
        assertJson(outcome); if (!["completed", "failed", "limited", "cancelled"].includes(outcome.status) || typeof outcome.terminationConfirmed !== "boolean") throw new TypeError("Invalid execution result");
        return outcome;
      });
      terminationConfirmed = result.terminationConfirmed;
      const { output, ...executionMetadata } = result;
      const retainedOutput = output === undefined || experiment.evidencePolicy?.retainContent !== true ? undefined : redactJson(output, experiment.evidencePolicy.redact);
      if (retainedOutput !== undefined) await sink.write({ id: "execution-output", mediaType: "application/json", content: JSON.stringify(retainedOutput) });
      state = { ...state, executionStatus: result.status, execution: { ...executionMetadata, ...(executionMetadata.reason === undefined ? {} : { reason: redact(executionMetadata.reason).slice(0, 4096) }), ...(retainedOutput === undefined ? {} : { output: retainedOutput }) }, metrics: { ...state.metrics, ...result.metrics } };
      resultMetrics = result.metrics;
      if (!terminationConfirmed) throw Object.assign(new Error("Execution termination could not be confirmed"), { code: "termination-unconfirmed" });
      if (result.status !== "cancelled" && (result.status !== "limited" || item.evaluateAfterLimit === true)) {
        const target = await phase("freeze", item.limits.evaluationTimeoutMs, signal => { pendingFreeze = environment!.freeze(signal); return pendingFreeze; });
        state = { ...state, evaluationTarget: target };
        await phase("evaluate", item.limits.evaluationTimeoutMs, async signal => {
          for (const reference of item.evaluators) {
            const evaluator = this.registry.evaluator(reference);
            let evaluation: EvaluationResult;
            try { evaluation = await evaluateTracked(() => evaluator.evaluate({ trial, case: item, variant, options: reference.options ?? {}, target, execution: result!, evidenceSink: scopedSink(sink, `${reference.id}:1`),
              emit: event => emit({ ...event, scope: "grader", id: `${reference.id}:1:${event.id}` }) }, signal)); signal.throwIfAborted(); validateResult(evaluation); }
            catch (error) { if (signal.aborted || !terminationConfirmed) throw error; state = { ...addError(state, errorRecord("evaluate", error)), infrastructureStatus: "failed" }; evaluation = { verdict: "inconclusive", checks: [], evidence: [] }; }
            state = applyRevision(state, { evaluatorId: reference.id, evaluatorVersion: reference.version, required: reference.required, revision: 1, createdAt: now(), result: evaluation }, item);
            if (evaluation.metrics !== undefined) gradingMetrics = addMetricOverrides(gradingMetrics, evaluation.metrics);
            pendingEvaluationApplied = true;
            signal.throwIfAborted(); await save();
          }
        });
      }
    } catch (error) {
      const reason = errorRecord(currentPhase, error); state = addError(state, reason);
      if ((currentPhase as EvalPhase) === "execute") {
        const status = reason.code === "phase-timeout" ? "limited" : this.options.signal?.aborted ? "cancelled" : "failed";
        state = { ...state, executionStatus: status };
        if (execution !== undefined) {
          try { terminationConfirmed = (await timed("cleanup", item.limits.cleanupTimeoutMs, undefined, signal => execution!.cancel(signal))).confirmed; }
          catch (cancelError) { terminationConfirmed = false; state = addError(state, errorRecord("cleanup", cancelError)); }
        }
        if (!terminationConfirmed) state = addError(state, { phase: "cleanup", code: "termination-unconfirmed", name: "TerminationError", message: "Execution termination could not be confirmed; its environment is retained" });
        if (status === "limited" && terminationConfirmed && item.evaluateAfterLimit === true && environment !== undefined) {
          try {
            const target = await phase("freeze", item.limits.evaluationTimeoutMs, signal => { pendingFreeze = environment!.freeze(signal); return pendingFreeze; }, false);
            const partial: EvalExecutionResult = { status, terminationConfirmed, reason: reason.code };
            state = { ...state, execution: partial, evaluationTarget: target };
            await phase("evaluate", item.limits.evaluationTimeoutMs, async signal => {
              for (const reference of item.evaluators) {
                const evaluation = await evaluateTracked(() => this.registry.evaluator(reference).evaluate({ trial, case: item, variant, options: reference.options ?? {}, target, execution: partial, evidenceSink: scopedSink(sink, `${reference.id}:1`), emit: event => emit({ ...event, scope: "grader", id: `${reference.id}:1:${event.id}` }) }, signal));
                signal.throwIfAborted(); validateResult(evaluation); state = applyRevision(state, { evaluatorId: reference.id, evaluatorVersion: reference.version, required: reference.required, revision: 1, createdAt: now(), result: evaluation }, item);
                if (evaluation.metrics !== undefined) gradingMetrics = addMetricOverrides(gradingMetrics, evaluation.metrics); pendingEvaluationApplied = true;
              }
            }, false);
          } catch (evaluationError) { state = addError(state, errorRecord(currentPhase, evaluationError)); }
        }
      } else state = { ...state, infrastructureStatus: "failed" };
    } finally {
      try { await phase("cleanup", item.limits.cleanupTimeoutMs, async signal => {
        if (pendingPrepare !== undefined && environment === undefined) await pendingPrepare.then(() => undefined, () => undefined);
        if (pendingCreate !== undefined && execution === undefined) await pendingCreate.then(() => undefined, () => undefined);
        if (pendingFreeze !== undefined) await pendingFreeze.then(() => undefined, () => undefined);
        if (pendingEvaluation !== undefined) await pendingEvaluation.then(evaluation => { if (!pendingEvaluationApplied && evaluation.metrics !== undefined) gradingMetrics = addMetricOverrides(gradingMetrics, evaluation.metrics); }, () => undefined);
        signal.throwIfAborted();
        if (execution !== undefined) await execution.close(signal);
        if (pendingExecute !== undefined) await pendingExecute.then(async outcome => {
          if (result !== undefined) return;
          assertJson(outcome as unknown); resultMetrics = outcome.metrics;
          const { output, ...metadata } = outcome;
          const retainedOutput = output === undefined || experiment.evidencePolicy?.retainContent !== true ? undefined : redactJson(output, experiment.evidencePolicy.redact);
          if (retainedOutput !== undefined) await sink.write({ id: "execution-output", mediaType: "application/json", content: JSON.stringify(retainedOutput) });
          state = { ...state, execution: { ...metadata, ...(metadata.reason === undefined ? {} : { reason: redact(metadata.reason).slice(0, 4096) }), ...(retainedOutput === undefined ? {} : { output: retainedOutput }) } };
        }, () => undefined);
        signal.throwIfAborted();
        if (environment !== undefined && terminationConfirmed) await environment.dispose(signal);
        else if (environment === undefined && pendingPrepare !== undefined && environmentAdapter.recover !== undefined) await environmentAdapter.recover({ trial, case: item, variant, options: item.environment.options ?? {}, signal });
      }, false); }
      catch (error) { state = { ...addError(state, errorRecord("cleanup", error)), infrastructureStatus: "failed" }; }
      const elapsed = state.phases.find(value => value.phase === "execute")?.durationMs;
      const evaluationDurations = state.phases.filter(value => value.phase === "evaluate" && value.durationMs !== undefined).map(value => value.durationMs!);
      if (evaluationDurations.length > 0) gradingMetrics = { ...gradingMetrics, durationMs: measured(evaluationDurations.reduce((sum, value) => sum + value, 0)) };
      state = { ...state, endedAt: now(), ...(state.executionStatus === undefined ? { executionStatus: this.options.signal?.aborted ? "cancelled" as const : "failed" as const } : {}), metrics: { ...state.metrics, ...(elapsed === undefined ? {} : { durationMs: measured(elapsed) }) } };
      if (resultMetrics !== undefined && elapsed !== undefined) resultMetrics = { ...resultMetrics, durationMs: measured(elapsed) };
      acceptingWrites = false; await save(); await this.options.onTrial?.(state);
    }
  }
  private evidenceSink(experiment: EvalExperiment, trial: EvalTrial, references: EvidenceReference[]): EvidenceSink {
    const policy = experiment.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY; let total = references.reduce((sum, value) => sum + value.bytes, 0);
    let queue = Promise.resolve();
    const write: EvidenceSink["write"] = async value => {
      if (typeof value.id !== "string" || !value.id || value.id.length > 512 || typeof value.content !== "string" || !value.mediaType || value.mediaType.length > 128) throw new TypeError("Invalid evidence content");
      const content = redact(policy.redact?.(value.content) ?? value.content); const bytes = Buffer.byteLength(content); const sha256 = createHash("sha256").update(content).digest("hex");
      const previous = references.find(reference => reference.id === value.id); if (previous !== undefined) { if (previous.sha256 !== sha256) throw new Error("Evidence id was reused with different content"); return previous; }
      if (bytes > policy.maxItemBytes || total + bytes > policy.maxTrialBytes || references.length >= policy.maxItems) throw new RangeError("Evidence retention limit exceeded");
      const reference: EvidenceReference = { id: value.id, mediaType: value.mediaType, bytes, sha256, ...(value.label === undefined ? {} : { label: redactText(value.label, policy.redact).slice(0, 256) }) };
      const saved = policy.retainContent === true ? await this.store.writeEvidence(experiment.id, trial.id, reference, content) : reference;
      references.push(saved); total += bytes; return saved;
    };
    return { write: value => { const pending = queue.then(() => write(value)); queue = pending.then(() => undefined, () => undefined); return pending; } };
  }
}

export function resolveTaskVerdict(item: EvalCase, revisions: readonly EvaluationRevision[]): { readonly verdict: TaskVerdict; readonly awaitingReview: boolean } {
  const required = item.evaluators.filter(value => value.required).map(reference => revisions.filter(value => value.evaluatorId === reference.id && value.evaluatorVersion === reference.version).at(-1));
  const awaitingReview = required.some(value => value?.result.verdict === "awaiting-review");
  if (required.some(value => value?.result.verdict === "failed" || value?.result.checks.some(check => check.verdict === "failed"))) return { verdict: "failed", awaitingReview };
  if (required.every(value => value?.result.verdict === "passed" && value.result.checks.every(check => check.verdict === "passed"))) return { verdict: "passed", awaitingReview };
  return { verdict: revisions.length === 0 ? "not-evaluated" : "inconclusive", awaitingReview };
}
function applyRevision(state: TrialState, revision: EvaluationRevision, item: EvalCase): TrialState { const evaluations = [...state.evaluations, revision]; const verdict = resolveTaskVerdict(item, evaluations); return { ...state, evaluations, taskVerdict: verdict.verdict, awaitingReview: verdict.awaitingReview }; }
function addError(state: TrialState, error: EvalError): TrialState { return { ...state, errors: [...state.errors, error] }; }
function errorRecord(phase: EvalPhase, error: unknown): EvalError { const value = error instanceof Error ? error : new Error(String(error)); const code = "code" in value && typeof value.code === "string" ? value.code : "unknown"; return { phase, code: code.slice(0, 128), name: value.name.slice(0, 128), message: redact(value.message).slice(0, 4096) }; }
function validateResult(result: EvaluationResult): void { assertJson(result); if (!["passed", "failed", "inconclusive", "awaiting-review"].includes(result.verdict) || !Array.isArray(result.checks) || !Array.isArray(result.evidence)) throw new TypeError("Invalid evaluation result"); for (const check of result.checks) if (!check.id || !["passed", "failed", "inconclusive"].includes(check.verdict)) throw new TypeError("Invalid evaluation check"); for (const score of Object.values(result.scores ?? {})) if (!Number.isFinite(score)) throw new TypeError("Scores must be finite"); }
async function timed<T>(phase: EvalPhase, timeoutMs: number, outer: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const abort = () => controller.abort(outer?.reason ?? new Error("Evaluation cancelled"));
  if (outer?.aborted) abort(); else outer?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined; let onAbort: (() => void) | undefined;
  try {
    const cancellation = new Promise<never>((_, reject) => { onAbort = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort(); timer = setTimeout(() => controller.abort(new PhaseLimitError(phase)), timeoutMs); });
    return await Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); }), cancellation]);
  } finally { if (timer !== undefined) clearTimeout(timer); if (onAbort !== undefined) controller.signal.removeEventListener("abort", onAbort); outer?.removeEventListener("abort", abort); }
}
function now(): string { return new Date().toISOString(); }
function measured(value: number): MeasuredValue { return { value, complete: true, missingReasons: [] }; }
function scopedSink(sink: EvidenceSink, prefix: string): EvidenceSink { return { write: value => sink.write({ ...value, id: `${prefix}:${value.id}` }) }; }
function unknown(reason: string): MeasuredValue { return { complete: false, missingReasons: [reason] }; }
function redact(value: string): string {
  let result = value.replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  for (const [key, secret] of Object.entries(process.env)) if (/(TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION)/i.test(key) && secret !== undefined && secret.length >= 4) result = result.replaceAll(secret, "[redacted]");
  return result;
}
function redactText(value: string, custom?: (value: string) => string): string { const result = custom?.(value) ?? value; if (typeof result !== "string") throw new TypeError("An evidence redactor must return a string"); return redact(result); }
function sanitizeState(state: TrialState, custom?: (value: string) => string): TrialState {
  const error = (value: EvalError): EvalError => ({ ...value, message: redactText(value.message, custom).slice(0, 4096) });
  return { ...state, errors: state.errors.map(error), phases: state.phases.map(value => value.error === undefined ? value : { ...value, error: error(value.error) }), evaluations: state.evaluations.map(value => ({ ...value, result: { ...value.result, checks: value.result.checks.map(check => check.message === undefined ? check : { ...check, message: redactText(check.message, custom).slice(0, 4096) }) } })) };
}
function redactJson(value: import("./types.js").JsonValue, custom?: (value: string) => string): import("./types.js").JsonValue {
  if (typeof value === "string") return redactText(value, custom);
  if (Array.isArray(value)) return value.map(entry => redactJson(entry, custom));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry, custom)]));
  return value;
}
function sanitizeEvent(event: EvalExecutionEvent): EvalExecutionEvent {
  const allowed = ["model-call", "model-attempt", "retry-wait", "tool-call", "tool-failure", "context-compaction", "human-intervention", "approval-wait", "usage", "identity"];
  if (!event.id || event.id.length > 512 || !allowed.includes(event.type)) throw new TypeError("Invalid execution event");
  if (event.durationMs !== undefined && (!Number.isFinite(event.durationMs) || event.durationMs < 0)) throw new RangeError("Event duration must be nonnegative");
  const saved = { id: event.id, type: event.type, ...(event.scope === undefined ? {} : { scope: event.scope }), ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }), ...(event.usage === undefined ? {} : { usage: event.usage }), ...(event.cost === undefined ? {} : { cost: event.cost }), ...(event.identities === undefined ? {} : { identities: event.identities }) };
  assertJson(saved); return saved;
}
class MetricsAccumulator {
  private readonly seen = new Set<string>(); private readonly counts: Record<string, number> = {}; private readonly receipts = new Map<string, { usage?: Usage; cost: UsageCost }>();
  constructor(private readonly variant: EvalVariant, private readonly item: EvalCase) {}
  record(event: EvalExecutionEvent): void {
    const key = `${event.scope ?? "agent"}:${event.type}:${event.id}`; if (this.seen.has(key)) return; if (this.seen.size >= 10_000) throw new RangeError("Trial telemetry exceeds 10,000 unique events per scope"); this.seen.add(key);
    const field = ({ "model-call": "modelCalls", "model-attempt": "modelAttempts", "retry-wait": "retryWaitMs", "tool-call": "toolCalls", "tool-failure": "toolFailures", "context-compaction": "contextCompactions", "human-intervention": "humanInterventions", "approval-wait": "approvalWaitMs" } as Record<string, string>)[event.type];
    if (field !== undefined) this.counts[field] = (this.counts[field] ?? 0) + (event.type === "retry-wait" || event.type === "approval-wait" ? event.durationMs ?? 0 : 1);
    if (event.type === "usage") { const budget = resolveRunBudget(this.item.limits.runBudget, this.variant.runBudget); this.receipts.set(event.id, { ...(event.usage === undefined ? {} : { usage: event.usage }), cost: event.cost === undefined ? priceUsage(event.usage, budget.pricing ?? budget.tokenPrices) : validateUsageCost(event.cost) }); }
  }
  snapshot(overrides?: EvalMetrics): EvalMetrics {
    let usage: Usage | undefined; const missing = new Set<string>();
    for (const receipt of this.receipts.values()) { const totals = resolveUsageTotals(receipt.usage); totals.missingReasons.forEach(reason => missing.add(reason)); usage = aggregateUsage(usage, receipt.usage); }
    const totals = resolveUsageTotals(usage); const calls = this.counts.modelCalls;
    if (calls !== undefined && calls > this.receipts.size) missing.add("model-call-usage-missing");
    const costs = [...this.receipts.values()].map(value => value.cost); const currencies = new Set(costs.map(value => value.currency)); const costReasons = [...new Set(costs.flatMap(value => value.missingReasons))];
    if (calls !== undefined && calls > costs.length) costReasons.push("model-call-cost-missing"); if (currencies.size > 1) costReasons.push("multiple-currencies"); if (costs.length === 0) costReasons.push("cost-not-reported");
    const cost: UsageCost = { ...(currencies.size <= 1 && costs.some(value => value.amount !== undefined) ? { amount: costs.reduce((sum, value) => sum + (value.amount ?? 0), 0) } : {}), currency: costs[0]?.currency ?? "USD", kind: costs.length > 0 && costs.every(value => value.kind === "provider") ? "provider" : "estimated", complete: costs.length > 0 && calls !== undefined && costs.length >= calls && currencies.size === 1 && costs.every(value => value.complete), missingReasons: costReasons, ...(costs.length === 1 && costs[0]!.pricingId !== undefined ? { pricingId: costs[0]!.pricingId } : {}), ...(costs.length === 1 && costs[0]!.pricingVersion !== undefined ? { pricingVersion: costs[0]!.pricingVersion } : {}) };
    const count = (field: string) => this.counts[field] === undefined ? unknown(`${field}-not-reported`) : measured(this.counts[field]!);
    return { durationMs: overrides?.durationMs ?? unknown("execution-not-finished"), approvalWaitMs: count("approvalWaitMs"), modelCalls: count("modelCalls"), modelAttempts: count("modelAttempts"), retryWaitMs: count("retryWaitMs"), toolCalls: count("toolCalls"), toolFailures: count("toolFailures"), contextCompactions: count("contextCompactions"), humanInterventions: count("humanInterventions"), totalTokens: { ...(totals.totalTokens === undefined ? {} : { value: totals.totalTokens }), complete: calls !== undefined && totals.complete && missing.size === 0, missingReasons: [...new Set([...totals.missingReasons, ...missing, ...(calls === undefined ? ["model-call-count-not-reported"] : [])])] }, cost, ...(usage === undefined ? {} : { usage }) };
  }
}
function mergeMetrics(previous: EvalMetrics, added: EvalMetrics, overrides?: Partial<EvalMetrics>): EvalMetrics {
  const result = { ...added };
  for (const field of ["durationMs", "approvalWaitMs", "modelCalls", "modelAttempts", "retryWaitMs", "toolCalls", "toolFailures", "contextCompactions", "humanInterventions", "totalTokens"] as const) {
    const a = previous[field]; const b = added[field]; result[field] = { ...(a.value === undefined && b.value === undefined ? {} : { value: (a.value ?? 0) + (b.value ?? 0) }), complete: a.complete && b.complete, missingReasons: [...new Set([...a.missingReasons, ...b.missingReasons])] };
  }
  const a = previous.cost; const b = added.cost; result.cost = { currency: a.currency, kind: a.kind === b.kind ? a.kind : "estimated", complete: a.complete && b.complete && a.currency === b.currency, missingReasons: [...new Set([...a.missingReasons, ...b.missingReasons, ...(a.currency === b.currency ? [] : ["multiple-currencies"])])], ...(a.currency === b.currency && (a.amount !== undefined || b.amount !== undefined) ? { amount: (a.amount ?? 0) + (b.amount ?? 0) } : {}) };
  return { ...result, ...overrides };
}
function addMetricOverrides(previous: Partial<EvalMetrics> | undefined, next: Partial<EvalMetrics>): Partial<EvalMetrics> {
  if (previous === undefined) return next;
  const merged: Partial<EvalMetrics> = { ...previous, ...next };
  for (const field of ["durationMs", "approvalWaitMs", "modelCalls", "modelAttempts", "retryWaitMs", "toolCalls", "toolFailures", "contextCompactions", "humanInterventions", "totalTokens"] as const) {
    const a = previous[field]; const b = next[field]; if (a !== undefined && b !== undefined) (merged as Record<string, unknown>)[field] = { ...(a.value === undefined && b.value === undefined ? {} : { value: (a.value ?? 0) + (b.value ?? 0) }), complete: a.complete && b.complete, missingReasons: [...new Set([...a.missingReasons, ...b.missingReasons])] };
  }
  if (previous.cost !== undefined && next.cost !== undefined) {
    const a = previous.cost; const b = next.cost;
    (merged as Record<string, unknown>).cost = { currency: a.currency, kind: a.kind === b.kind ? a.kind : "estimated", complete: a.complete && b.complete && a.currency === b.currency, missingReasons: [...new Set([...a.missingReasons, ...b.missingReasons, ...(a.currency === b.currency ? [] : ["multiple-currencies"])])], ...(a.currency === b.currency && (a.amount !== undefined || b.amount !== undefined) ? { amount: (a.amount ?? 0) + (b.amount ?? 0) } : {}) };
  }
  if (previous.usage !== undefined || next.usage !== undefined) (merged as Record<string, unknown>).usage = aggregateUsage(previous.usage, next.usage);
  return merged;
}
