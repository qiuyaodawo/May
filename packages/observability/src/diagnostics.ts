import type { TraceAttributes } from "@may/core";
import type { FinishedTraceSpan, SpanObserver, SpanProcessor, StartedTraceSpan } from "./types.js";
import { boundedAttributes } from "./limits.js";

export interface DiagnosticSpan extends StartedTraceSpan {
  readonly ended: boolean;
  readonly sampled: boolean;
  readonly endTime?: number;
  readonly durationMs?: number;
  readonly status?: FinishedTraceSpan["status"];
  readonly events?: FinishedTraceSpan["events"];
  readonly error?: FinishedTraceSpan["error"];
}

export interface TaskAssessment {
  readonly taskId: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly coordinationId?: string;
  readonly traceId?: string;
  readonly evaluator: string;
  readonly evaluatorVersion: string;
  readonly result: "passed" | "failed" | "inconclusive";
  readonly evidenceReferences?: readonly string[];
  readonly configurationVersion?: string;
  readonly timestamp?: number;
}

export interface DiagnosticQuery {
  readonly traceId?: string;
  readonly taskId?: string;
  readonly coordinationId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface DiagnosticResult {
  readonly spans: readonly DiagnosticSpan[];
  readonly assessments: readonly TaskAssessment[];
  readonly evictedSpans: number;
  readonly coverage: "all-local-spans";
  readonly total: number;
  readonly hasMore: boolean;
}

export class DiagnosticsStore implements SpanProcessor, SpanObserver {
  private readonly spans = new Map<string, DiagnosticSpan>();
  private readonly assessments: TaskAssessment[] = [];
  private readonly maxSpans: number;
  private readonly maxActiveSpans: number;
  private readonly retentionMs: number;
  private readonly maxAssessments: number;
  private evicted = 0;
  constructor(options: { maxSpans?: number; maxActiveSpans?: number; retentionMs?: number; maxAssessments?: number } = {}) {
    this.maxSpans = positive(options.maxSpans ?? 2_048);
    this.maxActiveSpans = positive(options.maxActiveSpans ?? 512);
    this.retentionMs = positive(options.retentionMs ?? 3_600_000);
    this.maxAssessments = positive(options.maxAssessments ?? 256);
  }
  onStart(span: StartedTraceSpan): void {
    this.prune();
    const active = [...this.spans.values()].filter(value => !value.ended);
    if (active.length >= this.maxActiveSpans) {
      this.spans.delete(active[0]!.context.spanId);
      this.evicted += 1;
    }
    const parentAttributes = span.parentSpanId === undefined ? {} : this.spans.get(span.parentSpanId)?.attributes ?? {};
    const inherited = Object.fromEntries(Object.entries(parentAttributes).filter(([key]) => ["may.task.id", "may.session.id", "may.run.id", "may.coordination.id", "may.scheduler.execution_id", "may.run.resumed_from"].includes(key)));
    this.spans.set(span.context.spanId, Object.freeze({ ...span, attributes: boundedAttributes({ ...inherited, ...span.attributes }), ended: false, sampled: span.context.sampled === true }));
  }
  onEnd(span: FinishedTraceSpan): void {
    this.spans.set(span.context.spanId, Object.freeze({ ...span, attributes: boundedAttributes({ ...this.spans.get(span.context.spanId)?.attributes, ...span.attributes }), ended: true, sampled: span.context.sampled === true }));
    this.prune();
  }
  recordAssessment(value: TaskAssessment): void {
    const attributes: Record<string, string> = { taskId: value.taskId, evaluator: value.evaluator, evaluatorVersion: value.evaluatorVersion };
    for (const key of ASSESSMENT_SCOPE_KEYS) if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || value[key].length === 0) throw new TypeError("Invalid assessment scope identifier");
      attributes[key] = value[key];
    }
    if (value.configurationVersion !== undefined) attributes.configurationVersion = value.configurationVersion;
    boundedAttributes(attributes);
    if (!value.taskId || !value.evaluator || !value.evaluatorVersion || !["passed", "failed", "inconclusive"].includes(value.result)) throw new TypeError("Invalid task assessment");
    if ((value.evidenceReferences?.length ?? 0) > 16 || value.evidenceReferences?.some(reference => typeof reference !== "string" || reference.length === 0 || reference.length > 256)) throw new TypeError("Invalid evidence references");
    const timestamp = value.timestamp ?? Date.now();
    if (!Number.isFinite(timestamp)) throw new TypeError("Invalid assessment timestamp");
    this.prune();
    const candidates = [...this.spans.values()].filter(span => span.attributes["may.task.id"] === value.taskId && ASSESSMENT_SCOPE_KEYS.every(key => value[key] === undefined || spanScope(span, key) === value[key]));
    const scope: Partial<Record<AssessmentScopeKey, string>> = {};
    for (const key of ASSESSMENT_SCOPE_KEYS) {
      if (value[key] !== undefined || candidates.length === 0) continue;
      const identifiers = new Set(candidates.map(span => spanScope(span, key)));
      const identifier = identifiers.values().next().value;
      if (identifiers.size === 1 && typeof identifier === "string") scope[key] = identifier;
    }
    this.assessments.push(Object.freeze({ ...scope, ...value, timestamp, ...(value.evidenceReferences === undefined ? {} : { evidenceReferences: Object.freeze([...value.evidenceReferences]) }) }));
    if (this.assessments.length > this.maxAssessments) this.assessments.shift();
  }
  getDiagnostics(query: DiagnosticQuery = {}): DiagnosticResult {
    this.prune();
    if (Object.keys(query).some(key => !["traceId", "taskId", "coordinationId", "sessionId", "runId", "limit", "offset"].includes(key))) throw new TypeError("Unknown diagnostic query field");
    for (const key of ["taskId", ...ASSESSMENT_SCOPE_KEYS] as const) if (query[key] !== undefined && (typeof query[key] !== "string" || query[key].length === 0 || query[key].length > 256)) throw new TypeError("Invalid diagnostic query identifier");
    const limit = positive(query.limit ?? 100);
    if (limit > 500) throw new RangeError("Diagnostic query limit cannot exceed 500");
    const offset = query.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("Diagnostic query offset must be non-negative");
    const spans = [...this.spans.values()].filter(span =>
      (query.traceId === undefined || span.context.traceId === query.traceId) &&
      (query.taskId === undefined || span.attributes["may.task.id"] === query.taskId) &&
      (query.coordinationId === undefined || span.attributes["may.coordination.id"] === query.coordinationId) &&
      (query.sessionId === undefined || span.attributes["may.session.id"] === query.sessionId) &&
      (query.runId === undefined || span.attributes["may.run.id"] === query.runId),
    ).sort((a, b) => a.startTime - b.startTime || a.context.spanId.localeCompare(b.context.spanId));
    const tasks = new Set(spans.map(span => span.attributes["may.task.id"]).filter((id): id is string => typeof id === "string"));
    const scoped = ASSESSMENT_SCOPE_KEYS.some(key => query[key] !== undefined);
    const assessments = this.assessments.filter(value =>
      (query.taskId === undefined || value.taskId === query.taskId) &&
      ASSESSMENT_SCOPE_KEYS.every(key => query[key] === undefined || value[key] === query[key]) &&
      (query.taskId !== undefined || scoped || tasks.has(value.taskId)),
    );
    return { spans: Object.freeze(spans.slice(offset, offset + limit)), assessments: Object.freeze(assessments.slice(-limit)), evictedSpans: this.evicted, coverage: "all-local-spans", total: spans.length, hasMore: offset + limit < spans.length };
  }
  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, value] of this.spans) {
      if (value.startTime < cutoff) { this.spans.delete(id); this.evicted += 1; }
    }
    const finished = [...this.spans.values()].filter(value => value.ended);
    for (const value of finished.slice(0, Math.max(0, finished.length - this.maxSpans))) {
      this.spans.delete(value.context.spanId); this.evicted += 1;
    }
  }
}

const ASSESSMENT_SCOPE_KEYS = ["sessionId", "runId", "coordinationId", "traceId"] as const;
type AssessmentScopeKey = typeof ASSESSMENT_SCOPE_KEYS[number];
function spanScope(span: DiagnosticSpan, key: AssessmentScopeKey): unknown {
  if (key === "traceId") return span.context.traceId;
  return span.attributes[key === "coordinationId" ? "may.coordination.id" : key === "runId" ? "may.run.id" : "may.session.id"];
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Diagnostic limits must be positive integers");
  return value;
}
