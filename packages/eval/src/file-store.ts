import { randomUUID, createHash } from "node:crypto";
import { open, mkdir, readFile, rename, unlink, stat, lstat } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Ajv } from "ajv";
import { validateUsageCost } from "@may/core";
import type { EvalStore, EvalPlan, TrialState, EvalExecutionEvent, EvidenceReference, EvalTrial, EvalFingerprints } from "./types.js";
import { assertJson, validateIdentifier } from "./validation.js";

export class FileEvalStore implements EvalStore {
  readonly directory: string;
  private readonly owned = new Map<string, DatabaseSync>();
  private readonly eventCounts = new Map<string, { count: number; bytes: number }>();
  private readonly eventQueues = new Map<string, Promise<void>>();
  constructor(options: { readonly directory: string }) { this.directory = resolve(options.directory); }

  async acquire(experimentId: string): Promise<() => Promise<void>> {
    validateIdentifier(experimentId, "experimentId");
    if (this.owned.has(experimentId)) throw new Error("This store already owns the experiment writer");
    const directory = this.experimentPath(experimentId);
    await mkdir(directory, { recursive: true });
    await this.checkDirectory(directory);
    const path = join(directory, "writer-lock.sqlite");
    try { const metadata = await lstat(path); if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Writer ownership requires a regular SQLite file"); } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
    const ownership = new DatabaseSync(path, { timeout: 0 });
    try { ownership.exec("BEGIN EXCLUSIVE"); } catch (error) { ownership.close(); throw new Error("Experiment already has an active writer or invalid ownership database", { cause: error }); }
    this.owned.set(experimentId, ownership);
    return async () => {
      if (this.owned.get(experimentId) !== ownership) return;
      const pending = [...this.eventQueues].filter(([key]) => key.startsWith(`${experimentId}:`)).map(([, value]) => value);
      const completed = await Promise.allSettled(pending);
      ownership.close();
      this.owned.delete(experimentId);
      const failure = completed.find((value): value is PromiseRejectedResult => value.status === "rejected"); if (failure !== undefined) throw failure.reason;
    };
  }
  async createPlan(plan: EvalPlan): Promise<void> {
    this.requireWriter(plan.experiment.id);
    if (!validatePlan(plan)) throw new TypeError(`Invalid experiment plan: ${JSON.stringify(validatePlan.errors)}`);
    const encoded = this.encode(plan);
    const handle = await open(join(this.experimentPath(plan.experiment.id), "plan.json"), "wx");
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
  }
  async readPlan(experimentId: string): Promise<EvalPlan> {
    const value = await this.readJson(join(this.experimentPath(experimentId), "plan.json")) as EvalPlan;
    if (!validatePlan(value)) throw new TypeError(`Invalid experiment plan: ${JSON.stringify(validatePlan.errors)}`);
    if (value.schemaVersion !== 1 || value.experiment.id !== experimentId) throw new Error("Unsupported or mismatched experiment plan");
    const identifiers = new Set<string>();
    for (const trial of value.trials) {
      validateIdentifier(trial.id, "trialId");
      if (trial.experimentId !== experimentId || identifiers.has(trial.id) || value.fingerprints[trial.id] === undefined || !value.experiment.cases.some(item => item.id === trial.caseId) || !value.experiment.variants.some(item => item.id === trial.variantId)) throw new TypeError("Inconsistent experiment plan trial");
      identifiers.add(trial.id);
    }
    return value;
  }
  async writeTrial(experimentId: string, state: TrialState): Promise<void> {
    this.requireWriter(experimentId);
    validateIdentifier(state.trial.id, "trialId");
    if (state.trial.experimentId !== experimentId) throw new Error("Trial experiment does not match");
    if (!validateState(state)) throw new TypeError(`Invalid trial state: ${JSON.stringify(validateState.errors)}`);
    validateUsageCost(state.metrics.cost); validateUsageCost(state.graderMetrics.cost);
    const directory = join(this.experimentPath(experimentId), "trials");
    await mkdir(directory, { recursive: true }); await this.checkDirectory(directory);
    await this.atomicWrite(join(directory, `${state.trial.id}.json`), state);
  }
  async readTrial(experimentId: string, trialId: string): Promise<TrialState | undefined> {
    validateIdentifier(trialId, "trialId");
    try {
      const value = await this.readJson(join(this.experimentPath(experimentId), "trials", `${trialId}.json`)) as TrialState;
      if (!validateState(value)) throw new TypeError(`Invalid trial state: ${JSON.stringify(validateState.errors)}`);
      if (value.trial.id !== trialId || value.trial.experimentId !== experimentId) throw new TypeError("Mismatched trial state identity");
      validateUsageCost(value.metrics.cost); validateUsageCost(value.graderMetrics.cost);
      return value;
    } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }
  async listTrials(experimentId: string): Promise<readonly TrialState[]> {
    const plan = await this.readPlan(experimentId);
    const values = await Promise.all(plan.trials.map(trial => this.readTrial(experimentId, trial.id)));
    return values.filter((value): value is TrialState => value !== undefined);
  }
  async appendEvent(experimentId: string, trialId: string, event: EvalExecutionEvent): Promise<void> {
    const key = `${experimentId}:${trialId}`;
    const pending = (this.eventQueues.get(key) ?? Promise.resolve()).then(() => this.appendEventRecord(experimentId, trialId, event));
    this.eventQueues.set(key, pending);
    try { await pending; } finally { if (this.eventQueues.get(key) === pending) this.eventQueues.delete(key); }
  }
  private async appendEventRecord(experimentId: string, trialId: string, event: EvalExecutionEvent): Promise<void> {
    this.requireWriter(experimentId); validateIdentifier(trialId, "trialId");
    const directory = join(this.experimentPath(experimentId), "events");
    await mkdir(directory, { recursive: true }); await this.checkDirectory(directory);
    assertJson(event); const encoded = `${JSON.stringify(event)}\n`; const bytes = Buffer.byteLength(encoded);
    if (bytes > 65_536) throw new RangeError("Telemetry event exceeds 64 KiB");
    const path = join(directory, `${trialId}.jsonl`); const key = `${experimentId}:${trialId}`;
    let accumulated = this.eventCounts.get(key);
    if (accumulated === undefined) {
      let existingBytes = 0; try { existingBytes = (await stat(path)).size; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; }
      let existingCount = 0; let reservedBytes = existingBytes;
      try { const metadata = await this.readJson(`${path}.meta.json`) as { count: number; bytes: number }; if (!Number.isSafeInteger(metadata.count) || metadata.count < 0 || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes < existingBytes) throw new Error("Telemetry metadata is inconsistent"); existingCount = metadata.count; reservedBytes = metadata.bytes; } catch (error) { if (!hasCode(error, "ENOENT")) throw error; if (existingBytes > 0) throw new Error("Telemetry metadata is unavailable"); }
      accumulated = { count: existingCount, bytes: reservedBytes }; this.eventCounts.set(key, accumulated);
    }
    if (accumulated.count >= 20_000 || accumulated.bytes + bytes > 16_777_216) throw new RangeError("Trial telemetry exceeds 20,000 appended events or 16 MiB");
    accumulated.count += 1; accumulated.bytes += bytes;
    await this.atomicWrite(`${path}.meta.json`, accumulated);
    const handle = await open(path, "a");
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
  }
  async writeEvidence(experimentId: string, trialId: string, reference: EvidenceReference, content: string): Promise<EvidenceReference> {
    this.requireWriter(experimentId); validateIdentifier(trialId, "trialId");
    if (typeof reference.id !== "string" || !reference.id || reference.id.length > 512) throw new TypeError("Invalid evidence id");
    if (Buffer.byteLength(content) !== reference.bytes || createHash("sha256").update(content).digest("hex") !== reference.sha256) throw new Error("Evidence metadata does not match its content");
    const directory = join(this.experimentPath(experimentId), "evidence", trialId);
    await mkdir(directory, { recursive: true }); await this.checkDirectory(directory);
    const path = join(directory, `${createHash("sha256").update(reference.id).digest("hex")}.txt`);
    const handle = await open(path, "wx");
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    return { ...reference, path: relative(this.experimentPath(experimentId), path).replaceAll("\\", "/") };
  }
  async appendTrial(experimentId: string, trial: EvalTrial, fingerprints: EvalFingerprints): Promise<void> {
    this.requireWriter(experimentId); const plan = await this.readPlan(experimentId);
    if (trial.experimentId !== experimentId || plan.trials.some(value => value.id === trial.id)) throw new Error("Invalid retry trial identity");
    await this.atomicWrite(join(this.experimentPath(experimentId), "plan.json"), { ...plan, trials: [...plan.trials, trial], fingerprints: { ...plan.fingerprints, [trial.id]: fingerprints } });
  }
  private requireWriter(experimentId: string): void { if (!this.owned.has(experimentId)) throw new Error("Acquire the experiment writer before modifying the store"); }
  private experimentPath(experimentId: string): string {
    validateIdentifier(experimentId, "experimentId"); const path = join(this.directory, experimentId);
    const child = relative(this.directory, path); if (child.startsWith("..") || isAbsolute(child)) throw new Error("Experiment path escapes the store");
    return path;
  }
  private async checkDirectory(directory: string): Promise<void> {
    let current = directory;
    while (true) {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new Error("Eval store directories must be regular directories");
      if (current === this.directory) return;
      const parent = resolve(current, "..");
      if (parent === current) throw new Error("Eval store directory escapes its root");
      current = parent;
    }
  }
  private encode(value: unknown): string { assertJson(value); const encoded = JSON.stringify(value, null, 2); if (Buffer.byteLength(encoded) > 33_554_432) throw new RangeError("Eval record exceeds 32 MiB"); return encoded; }
  private async readJson(path: string): Promise<unknown> { if ((await stat(path)).size > 33_554_432) throw new RangeError("Eval record exceeds 32 MiB"); const value: unknown = JSON.parse(await readFile(path, "utf8")); assertJson(value); return value; }
  private async atomicWrite(path: string, value: unknown): Promise<void> {
    const encoded = this.encode(value);
    const temporary = `${path}.${randomUUID()}.writing`;
    const handle = await open(temporary, "wx");
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    try { await rename(temporary, path); } catch (error) { await unlink(temporary); throw error; }
  }
}
function hasCode(value: unknown, code: string): boolean { return typeof value === "object" && value !== null && "code" in value && value.code === code; }

const textSchema = { type: "string", minLength: 1 };
const phaseSchema = { enum: ["prepare", "execute", "freeze", "evaluate", "cleanup"] };
const trialSchema = { type: "object", required: ["id", "experimentId", "caseId", "variantId", "repetition", "ordinal"], additionalProperties: false, properties: { id: textSchema, experimentId: textSchema, caseId: textSchema, variantId: textSchema, repetition: { type: "integer", minimum: 0 }, ordinal: { type: "integer", minimum: 0 }, retryOf: textSchema } };
const measuredSchema = { type: "object", required: ["complete", "missingReasons"], additionalProperties: false, properties: { value: { type: "number", minimum: 0 }, complete: { type: "boolean" }, missingReasons: { type: "array", items: textSchema } }, allOf: [{ if: { properties: { complete: { const: true } } }, then: { required: ["value"] } }] };
const metricFields = ["durationMs", "approvalWaitMs", "modelCalls", "modelAttempts", "retryWaitMs", "toolCalls", "toolFailures", "contextCompactions", "humanInterventions", "totalTokens"];
const metricsSchema = { type: "object", required: [...metricFields, "cost"], additionalProperties: false, properties: { ...Object.fromEntries(metricFields.map(field => [field, measuredSchema])), cost: { type: "object", required: ["currency", "kind", "complete", "missingReasons"] }, usage: { type: "object" } } };
const errorSchema = { type: "object", required: ["phase", "code", "name", "message"], additionalProperties: false, properties: { phase: phaseSchema, code: textSchema, name: textSchema, message: { type: "string", maxLength: 4096 } } };
const evidenceSchema = { type: "object", required: ["id", "mediaType", "bytes", "sha256"], additionalProperties: false, properties: { id: { type: "string", minLength: 1, maxLength: 512 }, mediaType: textSchema, bytes: { type: "integer", minimum: 0 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, path: textSchema, label: { type: "string", maxLength: 256 } } };
const resultSchema = { type: "object", required: ["verdict", "checks", "evidence"], additionalProperties: false, properties: { verdict: { enum: ["passed", "failed", "inconclusive", "awaiting-review"] }, checks: { type: "array", items: { type: "object", required: ["id", "verdict"], properties: { id: textSchema, verdict: { enum: ["passed", "failed", "inconclusive"] }, message: { type: "string" }, evidence: { type: "array", items: evidenceSchema } } } }, evidence: { type: "array", items: evidenceSchema }, scores: { type: "object", additionalProperties: { type: "number" } }, metrics: { type: "object" } } };
const validator = new Ajv({ strict: false, allErrors: true });
const validatePlan = validator.compile({ type: "object", required: ["schemaVersion", "experiment", "createdAt", "trials", "fingerprints"], additionalProperties: false, properties: {
  schemaVersion: { const: 1 }, createdAt: textSchema, experiment: { type: "object", required: ["id", "cases", "variants", "repetitions", "concurrency", "seed"], properties: { id: textSchema, cases: { type: "array", minItems: 1, items: { type: "object", required: ["id", "version", "description", "input", "environment", "evaluators", "limits"] } }, variants: { type: "array", minItems: 1, items: { type: "object", required: ["id", "version", "execution", "configuration"] } }, repetitions: { type: "integer", minimum: 1 }, concurrency: { type: "integer", minimum: 1 }, seed: { type: "integer" } } }, trials: { type: "array", items: trialSchema }, fingerprints: { type: "object", additionalProperties: { type: "object", required: ["case", "variant", "environment", "evaluators"], additionalProperties: { type: "string", pattern: "^[a-f0-9]{64}$" } } },
} });
const validateState = validator.compile({ type: "object", required: ["trial", "phases", "taskVerdict", "infrastructureStatus", "errors", "evaluations", "metrics", "graderMetrics", "evidence", "awaitingReview"], additionalProperties: false, properties: {
  trial: trialSchema, phases: { type: "array", items: { type: "object", required: ["phase", "startedAt", "status"], additionalProperties: false, properties: { phase: phaseSchema, startedAt: textSchema, endedAt: textSchema, durationMs: { type: "number", minimum: 0 }, status: { enum: ["running", "completed", "failed", "limited", "cancelled"] }, error: errorSchema } } }, startedAt: textSchema, endedAt: textSchema, environmentId: textSchema, evaluationTarget: { type: "object" }, executionStatus: { enum: ["completed", "failed", "limited", "cancelled", "interrupted"] }, execution: { type: "object", required: ["status", "terminationConfirmed"], properties: { status: { enum: ["completed", "failed", "limited", "cancelled"] }, terminationConfirmed: { type: "boolean" } } }, taskVerdict: { enum: ["passed", "failed", "inconclusive", "not-evaluated"] }, infrastructureStatus: { enum: ["ready", "failed", "interrupted"] }, errors: { type: "array", items: errorSchema }, evaluations: { type: "array", items: { type: "object", required: ["evaluatorId", "evaluatorVersion", "required", "revision", "createdAt", "result"], additionalProperties: false, properties: { evaluatorId: textSchema, evaluatorVersion: textSchema, required: { type: "boolean" }, revision: { type: "integer", minimum: 1 }, createdAt: textSchema, result: resultSchema } } }, metrics: metricsSchema, graderMetrics: metricsSchema, evidence: { type: "array", items: evidenceSchema }, awaitingReview: { type: "boolean" },
} });
