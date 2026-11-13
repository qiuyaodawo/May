import { createHash } from "node:crypto";
import { omitUndefined } from "@sortedyuan/may/core";
import { assertJson, DEFAULT_EVIDENCE_POLICY } from "./validation.js";
import type {
  EvalError,
  EvalExecutionEvent,
  EvalExperiment,
  EvalPhase,
  EvalStore,
  EvalTrial,
  EvidenceReference,
  EvidenceSink,
  TrialState,
} from "./types.js";

export function createEvidenceSink(
  store: EvalStore,
  experiment: EvalExperiment,
  trial: EvalTrial,
  references: EvidenceReference[],
): EvidenceSink {
  const policy = experiment.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY;
  let total = references.reduce((sum, value) => sum + value.bytes, 0);
  let queue = Promise.resolve();
  const write: EvidenceSink["write"] = async (value) => {
    if (
      typeof value.id !== "string" ||
      !value.id ||
      value.id.length > 512 ||
      typeof value.content !== "string" ||
      !value.mediaType ||
      value.mediaType.length > 128
    )
      throw new TypeError("Invalid evidence content");
    const content = redact(policy.redact?.(value.content) ?? value.content);
    const bytes = Buffer.byteLength(content);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const previous = references.find((reference) => reference.id === value.id);
    if (previous !== undefined) {
      if (previous.sha256 !== sha256) throw new Error("Evidence id was reused with different content");
      return previous;
    }
    if (bytes > policy.maxItemBytes || total + bytes > policy.maxTrialBytes || references.length >= policy.maxItems)
      throw new RangeError("Evidence retention limit exceeded");
    const reference: EvidenceReference = {
      id: value.id,
      mediaType: value.mediaType,
      bytes,
      sha256,
      ...(value.label === undefined ? {} : { label: redactText(value.label, policy.redact).slice(0, 256) }),
    };
    const saved =
      policy.retainContent === true
        ? await store.writeEvidence(experiment.id, trial.id, reference, content)
        : reference;
    references.push(saved);
    total += bytes;
    return saved;
  };
  return {
    write: (value) => {
      const pending = queue.then(() => write(value));
      queue = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
export function errorRecord(phase: EvalPhase, error: unknown): EvalError {
  const value = error instanceof Error ? error : new Error(String(error));
  const code = "code" in value && typeof value.code === "string" ? value.code : "unknown";
  return {
    phase,
    code: code.slice(0, 128),
    name: value.name.slice(0, 128),
    message: redact(value.message).slice(0, 4096),
  };
}
export function scopedSink(sink: EvidenceSink, prefix: string): EvidenceSink {
  return { write: (value) => sink.write({ ...value, id: `${prefix}:${value.id}` }) };
}
export function redact(value: string): string {
  let result = value
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]");
  for (const [key, secret] of Object.entries(process.env))
    if (/(TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION)/i.test(key) && secret !== undefined && secret.length >= 4)
      result = result.replaceAll(secret, "[redacted]");
  return result;
}
function redactText(value: string, custom?: (value: string) => string): string {
  const result = custom?.(value) ?? value;
  if (typeof result !== "string") throw new TypeError("An evidence redactor must return a string");
  return redact(result);
}
export function sanitizeState(state: TrialState, custom?: (value: string) => string): TrialState {
  const error = (value: EvalError): EvalError => ({
    ...value,
    message: redactText(value.message, custom).slice(0, 4096),
  });
  return {
    ...state,
    errors: state.errors.map(error),
    phases: state.phases.map((value) => (value.error === undefined ? value : { ...value, error: error(value.error) })),
    evaluations: state.evaluations.map((value) => ({
      ...value,
      result: {
        ...value.result,
        checks: value.result.checks.map((check) =>
          check.message === undefined ? check : { ...check, message: redactText(check.message, custom).slice(0, 4096) },
        ),
      },
    })),
  };
}
export function redactJson(
  value: import("./types.js").JsonValue,
  custom?: (value: string) => string,
): import("./types.js").JsonValue {
  if (typeof value === "string") return redactText(value, custom);
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, custom));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactJson(entry, custom)]));
  return value;
}
export function sanitizeEvent(event: EvalExecutionEvent): EvalExecutionEvent {
  const allowed = [
    "model-call",
    "model-attempt",
    "retry-wait",
    "tool-call",
    "tool-failure",
    "context-compaction",
    "human-intervention",
    "approval-wait",
    "usage",
    "identity",
  ];
  if (!event.id || event.id.length > 512 || !allowed.includes(event.type))
    throw new TypeError("Invalid execution event");
  if (event.durationMs !== undefined && (!Number.isFinite(event.durationMs) || event.durationMs < 0))
    throw new RangeError("Event duration must be nonnegative");
  const saved = omitUndefined({
    id: event.id,
    type: event.type,
    scope: event.scope,
    durationMs: event.durationMs,
    usage: event.usage,
    cost: event.cost,
    identities: event.identities,
  });
  assertJson(saved);
  return saved;
}
