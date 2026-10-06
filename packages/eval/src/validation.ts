import { createHash } from "node:crypto";
import { Ajv } from "ajv";
import { resolveRunBudget } from "@may/core";
import type { EvalRegistry } from "./registry.js";
import type { EvalExperiment, EvalFingerprints, EvalPlan, EvalTrial, EvidencePolicy, JsonValue } from "./types.js";

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = Object.freeze({ maxItemBytes: 65_536, maxTrialBytes: 1_048_576, maxItems: 64, retainContent: false });
const messageValidator = new Ajv({ strict: false, allErrors: true }).compile({ type: "array", minItems: 1, items: { type: "object", required: ["role", "content"], properties: {
  role: { enum: ["system", "user", "assistant", "tool"] }, content: { type: "array", items: { type: "object", required: ["type"], oneOf: [
    { properties: { type: { enum: ["text", "reasoning"] }, text: { type: "string" } }, required: ["text"] },
    { properties: { type: { const: "json" } }, required: ["value"] },
    { properties: { type: { enum: ["image", "audio", "file"] }, source: { type: "object", required: ["type"], oneOf: [
      { properties: { type: { const: "url" }, url: { type: "string", minLength: 1 } }, required: ["url"] },
      { properties: { type: { const: "base64" }, mediaType: { type: "string", minLength: 1 }, data: { type: "string" } }, required: ["mediaType", "data"] },
      { properties: { type: { const: "file" }, fileId: { type: "string", minLength: 1 } }, required: ["fileId"] },
    ] } }, required: ["source"] },
    { properties: { type: { const: "resource" }, uri: { type: "string", minLength: 1 } }, required: ["uri"] },
  ] } }, toolCallId: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, isError: { type: "boolean" }, toolCalls: { type: "array", items: { type: "object", required: ["id", "name", "input"], properties: { id: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 } } } },
}, allOf: [{ if: { properties: { role: { const: "tool" } } }, then: { required: ["toolCallId", "name"] } }] } });
export function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value) || value === "." || value === "..") throw new TypeError(`${label} must be a safe identifier`);
}
export function assertJson(value: unknown, label = "value", depth = 0): asserts value is JsonValue {
  if (depth > 32) throw new RangeError(`${label} exceeds the nesting limit`);
  if (typeof value === "string") { if (Buffer.byteLength(value) > 1_048_576) throw new RangeError(`${label} exceeds the 1 MiB string limit`); return; }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (Array.isArray(value)) {
    if (value.length > 100_000) throw new RangeError(`${label} exceeds the array limit`);
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) throw new TypeError(`${label} contains an empty array entry`);
      assertJson(value[index], `${label}[${index}]`, depth + 1);
    }
    return;
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (/^(api[-_]?key|password|secret|access[-_]?token|authorization|credentials|refresh[-_]?token)$/i.test(key)) throw new TypeError(`${label} contains a credential field: ${key}`);
      assertJson(child, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new TypeError(`${label} must contain lossless JSON data`);
}
export function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
export function serializableExperiment(experiment: EvalExperiment): EvalExperiment {
  const evidencePolicy = experiment.evidencePolicy === undefined ? undefined : { maxItemBytes: experiment.evidencePolicy.maxItemBytes, maxTrialBytes: experiment.evidencePolicy.maxTrialBytes, maxItems: experiment.evidencePolicy.maxItems, ...(experiment.evidencePolicy.retainContent === undefined ? {} : { retainContent: experiment.evidencePolicy.retainContent }), ...(experiment.evidencePolicy.redactorId === undefined ? {} : { redactorId: experiment.evidencePolicy.redactorId }), ...(experiment.evidencePolicy.redactorVersion === undefined ? {} : { redactorVersion: experiment.evidencePolicy.redactorVersion }) };
  return structuredClone({ ...experiment, ...(evidencePolicy === undefined ? {} : { evidencePolicy }) });
}
export function validateExperiment(experiment: EvalExperiment, registry: EvalRegistry): void {
  validateIdentifier(experiment.id, "experiment.id");
  integer(experiment.repetitions, "repetitions"); integer(experiment.concurrency, "concurrency");
  if (!Number.isSafeInteger(experiment.seed)) throw new RangeError("seed must be a safe integer");
  if (experiment.cases.length === 0 || experiment.variants.length === 0) throw new Error("An experiment requires cases and variants");
  if (experiment.cases.length * experiment.variants.length * experiment.repetitions > 100_000) throw new RangeError("Experiment exceeds the trial limit");
  unique(experiment.cases.map(value => value.id), "case"); unique(experiment.variants.map(value => value.id), "variant");
  const policy = experiment.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY;
  for (const key of ["maxItemBytes", "maxTrialBytes", "maxItems"] as const) integer(policy[key], `evidencePolicy.${key}`);
  if (policy.maxItemBytes > policy.maxTrialBytes) throw new RangeError("maxItemBytes exceeds maxTrialBytes");
  if (policy.redact !== undefined && typeof policy.redact !== "function") throw new TypeError("redact must be a function");
  if (policy.redact !== undefined && (!policy.redactorId || !policy.redactorVersion)) throw new TypeError("A custom redactor requires redactorId and redactorVersion");
  for (const item of experiment.cases) {
    validateIdentifier(item.id, "case.id"); text(item.version, "case.version"); text(item.description, "case.description");
    assertJson(item.input, "case.input");
    if (!messageValidator(item.input)) throw new TypeError(`Invalid case.input: ${JSON.stringify(messageValidator.errors)}`);
    reference(item.environment); const environment = registry.environment(item.environment);
    for (const [key, value] of Object.entries(item.requiredCapabilities ?? {})) {
      if (!(key in environment.capabilities) || typeof value !== "boolean") throw new TypeError(`Invalid required capability: ${key}`);
      if (value && !environment.capabilities[key as keyof typeof environment.capabilities]) throw new Error(`Environment ${environment.id} does not provide ${key}`);
    }
    if (experiment.concurrency > 1 && !environment.capabilities.independentResources) throw new Error(`Environment ${environment.id} cannot execute concurrent trials`);
    if (!item.evaluators.some(value => value.required)) throw new Error(`Case ${item.id} requires a required evaluator`);
    unique(item.evaluators.map(value => `${value.id}@${value.version}`), "evaluator");
    for (const evaluator of item.evaluators) { reference(evaluator); if (typeof evaluator.required !== "boolean") throw new TypeError("evaluator.required must be boolean"); registry.evaluator(evaluator); }
    for (const key of ["prepareTimeoutMs", "executionTimeoutMs", "evaluationTimeoutMs", "cleanupTimeoutMs"] as const) integer(item.limits[key], key, 2_147_483_647);
    assertJson(item.limits.runBudget, "case.runBudget"); resolveRunBudget(item.limits.runBudget);
    for (const variant of experiment.variants) {
      validateIdentifier(variant.id, "variant.id"); text(variant.version, "variant.version"); assertJson(variant.configuration, "variant.configuration");
      reference(variant.execution); const execution = registry.execution(variant.execution);
      if (variant.runBudget !== undefined) assertJson(variant.runBudget, "variant.runBudget");
      resolveRunBudget(item.limits.runBudget, variant.runBudget);
      execution.validateCase?.({ case: item, variant });
    }
  }
  assertJson(serializableExperiment(experiment), "experiment");
  if (Buffer.byteLength(JSON.stringify(serializableExperiment(experiment))) > 16_777_216) throw new RangeError("Experiment configuration exceeds 16 MiB");
}
export function createEvalPlan(experiment: EvalExperiment): EvalPlan {
  const trials: EvalTrial[] = [];
  let randomState = experiment.seed >>> 0;
  const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 0x1_0000_0000; };
  for (let repetition = 0; repetition < experiment.repetitions; repetition++) {
    for (const item of experiment.cases) {
      const variants = [...experiment.variants];
      for (let index = variants.length - 1; index > 0; index--) { const other = Math.floor(random() * (index + 1)); [variants[index], variants[other]] = [variants[other]!, variants[index]!]; }
      for (const variant of variants) trials.push({ id: `trial-${trials.length + 1}`, experimentId: experiment.id, caseId: item.id, variantId: variant.id, repetition, ordinal: trials.length });
    }
  }
  const fingerprints: Record<string, EvalFingerprints> = {};
  for (const trial of trials) fingerprints[trial.id] = trialFingerprints(experiment, trial);
  return { schemaVersion: 1, experiment: serializableExperiment(experiment), createdAt: new Date().toISOString(), trials, fingerprints };
}
export function trialFingerprints(experiment: EvalExperiment, trial: EvalTrial): EvalFingerprints {
  const item = experiment.cases.find(value => value.id === trial.caseId)!;
  const variant = experiment.variants.find(value => value.id === trial.variantId)!;
  return { case: fingerprint(item), variant: fingerprint(variant), environment: fingerprint(item.environment), evaluators: fingerprint(item.evaluators) };
}
function reference(value: import("./types.js").ComponentReference): void { validateIdentifier(value.id, "component.id"); text(value.version, "component.version"); if (value.options !== undefined) assertJson(value.options, "component.options"); }
function integer(value: number, label: string, max = 1_000_000_000): void { if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(`${label} must be a positive bounded safe integer`); }
function text(value: string, label: string): void { if (typeof value !== "string" || value.length === 0 || value.length > 16_384) throw new TypeError(`${label} must be nonempty bounded text`); }
function unique(values: readonly string[], label: string): void { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label} identifier`); }
