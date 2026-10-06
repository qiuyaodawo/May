import type { Message, RunBudget, Usage, UsageCost } from "@may/core";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export interface ComponentReference {
  readonly id: string;
  readonly version: string;
  readonly options?: Readonly<Record<string, JsonValue>>;
}
export interface EvaluatorReference extends ComponentReference {
  readonly required: boolean;
}
export interface EvalLimits {
  readonly prepareTimeoutMs: number;
  readonly executionTimeoutMs: number;
  readonly evaluationTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly runBudget: RunBudget;
}
export interface EnvironmentCapabilities {
  readonly independentResources: boolean;
  readonly filesystemIsolation: boolean;
  readonly processIsolation: boolean;
  readonly networkIsolation: boolean;
  readonly credentialIsolation: boolean;
  readonly protectedEvaluationResources?: boolean;
}
export interface EvalCase {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly input: readonly Message[];
  readonly environment: ComponentReference;
  readonly evaluators: readonly EvaluatorReference[];
  readonly limits: EvalLimits;
  readonly tags?: readonly string[];
  readonly requiredCapabilities?: Partial<EnvironmentCapabilities>;
  readonly evaluateAfterLimit?: boolean;
}
export interface EvalVariant {
  readonly id: string;
  readonly version: string;
  readonly execution: ComponentReference;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly runBudget?: RunBudget;
  readonly assisted?: boolean;
}
export interface EvidencePolicy {
  readonly maxItemBytes: number;
  readonly maxTrialBytes: number;
  readonly maxItems: number;
  readonly retainContent?: boolean;
  readonly redact?: (value: string) => string;
  readonly redactorId?: string;
  readonly redactorVersion?: string;
}
export interface EvalExperiment {
  readonly id: string;
  readonly cases: readonly EvalCase[];
  readonly variants: readonly EvalVariant[];
  readonly repetitions: number;
  readonly concurrency: number;
  readonly seed: number;
  readonly evidencePolicy?: EvidencePolicy;
}
export interface EvalTrial {
  readonly id: string;
  readonly experimentId: string;
  readonly caseId: string;
  readonly variantId: string;
  readonly repetition: number;
  readonly ordinal: number;
  readonly retryOf?: string;
}
export interface EvalFingerprints {
  readonly case: string;
  readonly variant: string;
  readonly environment: string;
  readonly evaluators: string;
}
export interface EvalPlan {
  readonly schemaVersion: 1;
  readonly experiment: EvalExperiment;
  readonly createdAt: string;
  readonly trials: readonly EvalTrial[];
  readonly fingerprints: Readonly<Record<string, EvalFingerprints>>;
}
export type EvalPhase = "prepare" | "execute" | "freeze" | "evaluate" | "cleanup";
export interface EvalError {
  readonly phase: EvalPhase;
  readonly code: string;
  readonly name: string;
  readonly message: string;
}
export interface EvalPhaseRecord {
  readonly phase: EvalPhase;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
  readonly status: "running" | "completed" | "failed" | "limited" | "cancelled";
  readonly error?: EvalError;
}
export type ExecutionStatus = "completed" | "failed" | "limited" | "cancelled" | "interrupted";
export type TaskVerdict = "passed" | "failed" | "inconclusive" | "not-evaluated";
export interface EvalIdentities {
  readonly taskIds?: readonly string[];
  readonly sessionIds?: readonly string[];
  readonly runIds?: readonly string[];
  readonly coordinationIds?: readonly string[];
  readonly traceIds?: readonly string[];
}
export interface MeasuredValue {
  readonly value?: number;
  readonly complete: boolean;
  readonly missingReasons: readonly string[];
}
export interface EvalMetrics {
  readonly durationMs: MeasuredValue;
  readonly approvalWaitMs: MeasuredValue;
  readonly modelCalls: MeasuredValue;
  readonly modelAttempts: MeasuredValue;
  readonly retryWaitMs: MeasuredValue;
  readonly toolCalls: MeasuredValue;
  readonly toolFailures: MeasuredValue;
  readonly contextCompactions: MeasuredValue;
  readonly humanInterventions: MeasuredValue;
  readonly totalTokens: MeasuredValue;
  readonly cost: UsageCost;
  readonly usage?: Usage;
}
export interface EvidenceReference {
  readonly id: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path?: string;
  readonly label?: string;
}
export interface EvidenceSink {
  write(value: { readonly id: string; readonly mediaType: string; readonly content: string; readonly label?: string }): Promise<EvidenceReference>;
}
export interface EvalExecutionEvent {
  readonly id: string;
  readonly type: "model-call" | "model-attempt" | "retry-wait" | "tool-call" | "tool-failure" | "context-compaction" | "human-intervention" | "approval-wait" | "usage" | "identity";
  readonly scope?: "agent" | "grader";
  readonly durationMs?: number;
  readonly usage?: Usage;
  readonly cost?: UsageCost;
  readonly identities?: EvalIdentities;
}
export interface EvalExecutionResult {
  readonly status: Exclude<ExecutionStatus, "interrupted">;
  readonly terminationConfirmed: boolean;
  readonly output?: JsonValue;
  readonly reason?: string;
  readonly identities?: EvalIdentities;
  readonly metrics?: Partial<EvalMetrics>;
  readonly evidence?: readonly EvidenceReference[];
}
export interface ExecutionTarget {
  readonly workspacePath?: string;
  readonly data?: Readonly<Record<string, JsonValue>>;
}
export interface EvaluationTarget extends ExecutionTarget {
  readonly baselinePath?: string;
}
export interface EnvironmentPrepareContext {
  readonly trial: EvalTrial;
  readonly case: EvalCase;
  readonly variant: EvalVariant;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
}
export interface EvalComponent {
  readonly id: string;
  readonly version: string;
  validate?(options: Readonly<Record<string, JsonValue>>): void;
}
export interface EvalEnvironmentAdapter extends EvalComponent {
  readonly capabilities: EnvironmentCapabilities;
  prepare(context: EnvironmentPrepareContext): Promise<PreparedEnvironment>;
  recover?(context: EnvironmentPrepareContext): Promise<void>;
}
export interface PreparedEnvironment {
  readonly id: string;
  readonly capabilities: EnvironmentCapabilities;
  readonly executionTarget: ExecutionTarget;
  freeze(signal: AbortSignal): Promise<EvaluationTarget>;
  dispose(signal: AbortSignal): Promise<void>;
}
export interface ExecutionCreateContext {
  readonly trial: EvalTrial;
  readonly case: EvalCase;
  readonly variant: EvalVariant;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly target: ExecutionTarget;
  readonly runBudget: Readonly<RunBudget>;
  readonly evidenceSink: EvidenceSink;
  readonly emit: (event: EvalExecutionEvent) => Promise<void>;
  readonly signal: AbortSignal;
}
export interface EvalExecutionAdapter extends EvalComponent {
  validateCase?(context: { readonly case: EvalCase; readonly variant: EvalVariant }): void;
  create(context: ExecutionCreateContext): Promise<EvalExecution>;
  recover?(context: { readonly state: TrialState; readonly case: EvalCase; readonly variant: EvalVariant; readonly signal: AbortSignal }): Promise<{ readonly confirmed: boolean }>;
}
export interface EvalExecution {
  execute(signal: AbortSignal): Promise<EvalExecutionResult>;
  cancel(signal: AbortSignal): Promise<{ readonly confirmed: boolean }>;
  close(signal: AbortSignal): Promise<void>;
}
export interface EvaluationCheck {
  readonly id: string;
  readonly verdict: "passed" | "failed" | "inconclusive";
  readonly message?: string;
  readonly evidence?: readonly EvidenceReference[];
}
export interface EvaluationResult {
  readonly verdict: "passed" | "failed" | "inconclusive" | "awaiting-review";
  readonly checks: readonly EvaluationCheck[];
  readonly scores?: Readonly<Record<string, number>>;
  readonly evidence: readonly EvidenceReference[];
  readonly metrics?: Partial<EvalMetrics>;
}
export interface EvaluationContext {
  readonly trial: EvalTrial;
  readonly case: EvalCase;
  readonly variant: EvalVariant;
  readonly options: Readonly<Record<string, JsonValue>>;
  readonly target: EvaluationTarget;
  readonly execution: EvalExecutionResult;
  readonly evidenceSink: EvidenceSink;
  readonly emit: (event: EvalExecutionEvent) => Promise<void>;
}
export interface EvalEvaluator extends EvalComponent {
  evaluate(context: EvaluationContext, signal: AbortSignal): Promise<EvaluationResult>;
}
export interface EvaluationRevision {
  readonly evaluatorId: string;
  readonly evaluatorVersion: string;
  readonly required: boolean;
  readonly revision: number;
  readonly createdAt: string;
  readonly result: EvaluationResult;
}
export interface TrialState {
  readonly trial: EvalTrial;
  readonly phases: readonly EvalPhaseRecord[];
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly environmentId?: string;
  readonly evaluationTarget?: EvaluationTarget;
  readonly executionStatus?: ExecutionStatus;
  readonly execution?: EvalExecutionResult;
  readonly taskVerdict: TaskVerdict;
  readonly infrastructureStatus: "ready" | "failed" | "interrupted";
  readonly errors: readonly EvalError[];
  readonly evaluations: readonly EvaluationRevision[];
  readonly metrics: EvalMetrics;
  readonly graderMetrics: EvalMetrics;
  readonly evidence: readonly EvidenceReference[];
  readonly awaitingReview: boolean;
}
export interface EvalStore {
  acquire(experimentId: string): Promise<() => Promise<void>>;
  createPlan(plan: EvalPlan): Promise<void>;
  readPlan(experimentId: string): Promise<EvalPlan>;
  writeTrial(experimentId: string, state: TrialState): Promise<void>;
  readTrial(experimentId: string, trialId: string): Promise<TrialState | undefined>;
  listTrials(experimentId: string): Promise<readonly TrialState[]>;
  appendEvent(experimentId: string, trialId: string, event: EvalExecutionEvent): Promise<void>;
  writeEvidence(experimentId: string, trialId: string, reference: EvidenceReference, content: string): Promise<EvidenceReference>;
  appendTrial(experimentId: string, trial: EvalTrial, fingerprints: EvalFingerprints): Promise<void>;
}
export interface EvalRunnerOptions {
  readonly registry: import("./registry.js").EvalRegistry;
  readonly store: EvalStore;
  readonly signal?: AbortSignal;
  readonly onTrial?: (state: TrialState) => void | Promise<void>;
}
