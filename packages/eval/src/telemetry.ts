import type { AgentApplicationEvent } from "@may/application";
import { priceUsage, resolveUsageTotals, validateUsageCost, type RunBudget, type Usage, type UsageCost, type TraceAttributes } from "@may/core";
import {
  BasicTracer,
  type FinishedTraceSpan,
  type SpanObserver,
  type SpanProcessor,
  type StartedTraceSpan,
  type TaskAssessment,
} from "@may/observability";
import type { EvalExecutionEvent, EvalIdentities, EvalMetrics, MeasuredValue } from "./types.js";

export interface EvalAgentMetrics {
  readonly modelCalls: number;
  readonly modelAttempts: number;
  readonly modelAttemptsComplete: boolean;
  readonly coverageComplete: boolean;
  readonly coverageMissingReasons: readonly string[];
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly retryWaitMs: number;
  readonly contextCompactions: number;
  readonly humanInterventions: number;
  readonly approvalWaitMs: number;
  readonly tokens: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly complete: boolean;
    readonly missingReasons: readonly string[];
  };
  readonly costs: readonly UsageCost[];
}

export interface EvalAgentIdentities {
  readonly sessionIds: readonly string[];
  readonly runIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly coordinationIds: readonly string[];
  readonly traceIds: readonly string[];
}

export interface EvalApprovalEvidence {
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestedAt: number;
  readonly resolvedAt?: number;
  readonly status: "pending" | "resolved" | "cancelled";
  readonly decision?: string;
}

const scopeKeys = ["may.session.id", "may.run.id", "may.task.id", "may.coordination.id"] as const;
const safeAttributes = new Set([
  ...scopeKeys, "may.model.call_id", "may.model.attempt_id", "may.model.attempt",
  "may.model.input_tokens", "may.model.output_tokens", "may.model.total_tokens",
  "may.model.usage_complete", "may.model.cost", "may.model.currency", "may.model.cost_kind",
  "may.model.cost_complete", "may.model.pricing_id", "may.model.pricing_version", "may.model.completed",
  "may.tool.call_id",
  "may.step",
  "may.model.attempts_complete",
]);

export class EvalTelemetryCollector implements SpanObserver, SpanProcessor {
  readonly tracer: BasicTracer;
  private readonly scopes = new Map<string, TraceAttributes>();
  private readonly spans = new Map<string, FinishedTraceSpan>();
  private readonly events = new Set<string>();
  private readonly calls = new Map<string, FinishedTraceSpan>();
  private readonly attempts = new Set<string>();
  private readonly tools = new Map<string, boolean>();
  private readonly approvals = new Map<string, number>();
  private readonly seenApprovals = new Set<string>();
  private readonly approvalRecords = new Map<string, EvalApprovalEvidence>();
  private readonly sessions = new Set<string>();
  private readonly runs = new Set<string>();
  private readonly tasks = new Set<string>();
  private readonly coordinations = new Set<string>();
  private readonly traces = new Set<string>();
  private readonly pendingEvents = new Map<string, EvalExecutionEvent>();
  private readonly usage = new Map<string, Usage>();
  private readonly receiptCosts = new Map<string, UsageCost>();
  private retryWait = 0;
  private compactions = 0;
  private human = 0;
  private approvalWait = 0;
  private exceededRecords = false;
  private readonly coverageErrors = new Set<string>();

  constructor(private readonly runBudget: Readonly<RunBudget> = {}, private readonly maxRecords = 100_000) {
    if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) throw new RangeError("Telemetry maxRecords must be a positive safe integer");
    this.tracer = new BasicTracer({ processor: this, observer: this });
  }

  onStart(span: StartedTraceSpan): void {
    if (this.scopes.size >= this.maxRecords) { this.exceededRecords = true; return; }
    const inherited = span.parentSpanId === undefined ? {} : this.scopes.get(span.parentSpanId) ?? {};
    const scope = Object.fromEntries(scopeKeys.flatMap(key => {
      const value = span.attributes[key] ?? inherited[key];
      return typeof value === "string" ? [[key, value]] : [];
    }));
    this.scopes.set(span.context.spanId, scope);
    this.track({ ...span.attributes, ...scope }, span.context.traceId);
  }

  onEnd(span: FinishedTraceSpan): void {
    if (this.spans.has(span.context.spanId)) return;
    if (this.spans.size >= this.maxRecords) { this.exceededRecords = true; this.scopes.delete(span.context.spanId); return; }
    const attributes = Object.fromEntries(Object.entries({ ...this.scopes.get(span.context.spanId), ...span.attributes })
      .filter(([key]) => safeAttributes.has(key)));
    const saved = { ...span, attributes, events: [], error: span.error === undefined ? undefined : { name: span.error.name, ...(span.error.code === undefined ? {} : { code: span.error.code }) } };
    const sanitized: FinishedTraceSpan = {
      name: saved.name, context: saved.context, startTime: saved.startTime, endTime: saved.endTime,
      durationMs: saved.durationMs, status: saved.status, attributes, events: [],
      ...(saved.parentSpanId === undefined ? {} : { parentSpanId: saved.parentSpanId }),
      ...(saved.error === undefined ? {} : { error: saved.error }),
    };
    this.spans.set(span.context.spanId, sanitized);
    this.scopes.delete(span.context.spanId);
    this.track(attributes, span.context.traceId);
    if (span.name === "may.model.call") {
      const identity = text(attributes, "may.model.call_id") ?? span.context.spanId;
      this.calls.set(identity, sanitized);
    }
    if (span.name === "may.model.attempt") this.attempts.add(text(attributes, "may.model.attempt_id") ?? span.context.spanId);
    if (span.name === "may.tool.call") this.tools.set(`${text(attributes, "may.run.id") ?? span.context.traceId}:${numeric(attributes, "may.step")}:${text(attributes, "may.tool.call_id") ?? span.context.spanId}`, span.status === "error");
  }

  observe(event: AgentApplicationEvent, sessionId: string): void {
    this.sessions.add(sessionId);
    if (event.type === "context.compacted") { this.compactions += 1; return; }
    if (event.type === "run.event") {
      const value = event.event;
      if (["model.text.delta", "model.reasoning.delta", "tool.output.delta", "tool.progress"].includes(value.type)) return;
      const id = `${sessionId}:${value.runId}:${value.seq}`;
      if (this.events.has(id)) return;
      if (this.events.size >= this.maxRecords) { this.exceededRecords = true; return; }
      this.events.add(id);
      this.runs.add(value.runId);
      if (value.type === "model.retrying") this.retryWait += value.delayMs;
      if (value.type === "model.retrying") this.pendingEvents.set(id, { id, type: "retry-wait", durationMs: value.delayMs });
      if (value.type === "model.completed" && value.usage !== undefined) this.usage.set(`${value.runId}:model:${value.step}`, value.usage);
      if (value.type === "tool.started") this.tools.set(`${value.runId}:${value.step}:${value.call.id}`, false);
      if (value.type === "tool.failed") this.tools.set(`${value.runId}:${value.step}:${value.call.id}`, true);
      return;
    }
    if (event.type !== "permission.event") return;
    const value = event.event;
    if (value.type === "approval.requested") {
      const id = `${sessionId}:${value.request.id}`;
      if (this.seenApprovals.size >= this.maxRecords) { this.exceededRecords = true; return; }
      if (!this.seenApprovals.has(id)) {
        this.seenApprovals.add(id);
        this.approvals.set(id, value.timestamp);
        this.approvalRecords.set(id, { requestId: value.request.id, sessionId, requestedAt: value.timestamp, status: "pending" });
      }
    } else if (value.type === "approval.resolved" || value.type === "approval.cancelled") {
      const id = `${sessionId}:${value.requestId}`;
      const started = this.approvals.get(id);
      if (started !== undefined) {
        this.approvalWait += Math.max(0, value.timestamp - started);
        this.approvals.delete(id);
        this.approvalRecords.set(id, { ...this.approvalRecords.get(id)!, resolvedAt: value.timestamp,
          status: value.type === "approval.resolved" ? "resolved" : "cancelled",
          ...(value.type === "approval.resolved" ? { decision: value.decision } : {}) });
      }
    }
  }

  recordHumanIntervention(): void { this.human += 1; }

  recordModelReceipt(callId: string, usage: Usage | undefined, cost: UsageCost | undefined): void {
    if (this.receiptCosts.size >= this.maxRecords || this.usage.size >= this.maxRecords) { this.exceededRecords = true; return; }
    if (usage !== undefined) this.usage.set(callId, structuredClone(usage));
    if (cost !== undefined) this.receiptCosts.set(callId, validateUsageCost(cost));
  }

  async flush(emit: (event: EvalExecutionEvent) => Promise<void>, scope: "agent" | "grader" = "agent"): Promise<void> {
    for (const [id, span] of this.calls) {
      await emit({ id, type: "model-call", scope });
      const receipt = this.usage.get(id) ?? spanUsage(span.attributes);
      const cost = this.cost(span, receipt);
      await emit({ id: `${id}:usage`, type: "usage", scope, ...(receipt === undefined ? {} : { usage: receipt }), cost });
    }
    for (const id of this.attempts) await emit({ id, type: "model-attempt", scope });
    for (const [id, failed] of this.tools) {
      await emit({ id: `${id}:started`, type: "tool-call", scope });
      if (failed) await emit({ id: `${id}:failed`, type: "tool-failure", scope });
    }
    for (const event of this.pendingEvents.values()) await emit({ ...event, scope });
    for (let index = 0; index < this.compactions; index++) await emit({ id: `compaction:${index}`, type: "context-compaction", scope });
    for (let index = 0; index < this.human; index++) await emit({ id: `human:${index}`, type: "human-intervention", scope });
    await emit({ id: "approval-wait", type: "approval-wait", scope, durationMs: this.metrics().approvalWaitMs });
    await emit({ id: "identities", type: "identity", scope, identities: this.identities() });
  }

  identities(): EvalAgentIdentities {
    return { sessionIds: [...this.sessions], runIds: [...this.runs], taskIds: [...this.tasks],
      coordinationIds: [...this.coordinations], traceIds: [...this.traces] };
  }

  evidence(): readonly FinishedTraceSpan[] { return [...this.spans.values()]; }
  approvalEvidence(): readonly EvalApprovalEvidence[] { return [...this.approvalRecords.values()]; }
  modelCallIds(): readonly string[] { return [...this.calls.keys()]; }
  successfulToolCallIds(): readonly string[] {
    return [...this.spans.values()].filter(span => span.name === "may.tool.call" && span.status === "ok")
      .map(span => `${text(span.attributes, "may.run.id") ?? span.context.traceId}:${numeric(span.attributes, "may.step")}:${text(span.attributes, "may.tool.call_id") ?? span.context.spanId}`);
  }
  markIncomplete(reason: string): void { this.coverageErrors.add(reason); }

  metrics(now = Date.now()): EvalAgentMetrics {
    const missing = new Set<string>();
    const totals: Record<string, number> = {};
    const costs = new Map<string, { amount?: number; currency: string; kind: "estimated" | "provider"; complete: boolean; missingReasons: string[]; pricingId?: string; pricingVersion?: string; source?: string; effectiveAt?: string }>();
    for (const [callId, span] of this.calls) {
      const attributes = span.attributes;
      const receipt = this.usage.get(callId) ?? spanUsage(attributes);
      const usageTotals = resolveUsageTotals(receipt);
      for (const [field, key] of [["inputTokens", "input_tokens"], ["outputTokens", "output_tokens"], ["totalTokens", "total_tokens"]]) {
        const value = field === "totalTokens" ? usageTotals.totalTokens : numeric(attributes, `may.model.${key}`);
        if (value !== undefined) totals[field!] = (totals[field!] ?? 0) + value;
        else missing.add(`${field}-missing`);
      }
      if (attributes["may.model.usage_complete"] !== true) missing.add("one-or-more-model-calls-have-incomplete-usage");
      const receiptCost = this.cost(span, receipt);
      const { currency, kind, pricingId, pricingVersion } = receiptCost;
      const key = JSON.stringify([currency, kind, pricingId, pricingVersion]);
      const cost = costs.get(key) ?? { currency, kind, complete: true, missingReasons: [],
        ...(pricingId === undefined ? {} : { pricingId }), ...(pricingVersion === undefined ? {} : { pricingVersion }),
        ...(receiptCost.source === undefined ? {} : { source: receiptCost.source }),
        ...(receiptCost.effectiveAt === undefined ? {} : { effectiveAt: receiptCost.effectiveAt }) };
      const amount = receiptCost.amount;
      if (amount !== undefined) cost.amount = (cost.amount ?? 0) + amount;
      if (!receiptCost.complete || amount === undefined) {
        cost.complete = false;
        cost.missingReasons = [...new Set([...cost.missingReasons, ...receiptCost.missingReasons])];
      }
      costs.set(key, cost);
    }
    if (this.calls.size === 0) missing.add("model-call-telemetry-missing");
    if (this.exceededRecords) missing.add("telemetry-entry-limit");
    for (const reason of this.coverageErrors) missing.add(reason);
    return {
      modelCalls: this.calls.size, modelAttempts: this.attempts.size,
      modelAttemptsComplete: [...this.calls.values()].every(span => span.attributes["may.model.attempts_complete"] !== false),
      coverageComplete: !this.exceededRecords && this.coverageErrors.size === 0,
      coverageMissingReasons: [...(this.exceededRecords ? ["telemetry-entry-limit"] : []), ...this.coverageErrors],
      toolCalls: this.tools.size, toolFailures: [...this.tools.values()].filter(Boolean).length,
      retryWaitMs: this.retryWait, contextCompactions: this.compactions, humanInterventions: this.human,
      approvalWaitMs: this.approvalWait + [...this.approvals.values()].reduce((sum, started) => sum + Math.max(0, now - started), 0),
      tokens: { ...totals, complete: missing.size === 0, missingReasons: [...missing] }, costs: [...costs.values()],
    };
  }

  private cost(span: FinishedTraceSpan, receipt: Usage | undefined): UsageCost {
    const id = text(span.attributes, "may.model.call_id");
    const recorded = id === undefined ? undefined : this.receiptCosts.get(id);
    if (recorded !== undefined) return recorded;
    const calculated = priceUsage(receipt, this.runBudget.pricing ?? this.runBudget.tokenPrices, this.runBudget.usagePricer);
    const amount = numeric(span.attributes, "may.model.cost");
    if (amount === undefined) return calculated;
    const complete = span.attributes["may.model.cost_complete"] === true;
    const pricingId = text(span.attributes, "may.model.pricing_id");
    const pricingVersion = text(span.attributes, "may.model.pricing_version");
    return { ...calculated, amount, currency: text(span.attributes, "may.model.currency") ?? calculated.currency,
      kind: span.attributes["may.model.cost_kind"] === "provider" ? "provider" : "estimated", complete,
      ...(pricingId === undefined ? {} : { pricingId }), ...(pricingVersion === undefined ? {} : { pricingVersion }),
      missingReasons: complete ? [] : calculated.missingReasons.length ? calculated.missingReasons : ["model-cost-incomplete"] };
  }

  private track(attributes: TraceAttributes, traceId: string): void {
    this.traces.add(traceId);
    for (const [key, values] of [["may.session.id", this.sessions], ["may.run.id", this.runs],
      ["may.task.id", this.tasks], ["may.coordination.id", this.coordinations]] as const) {
      const value = text(attributes, key);
      if (value !== undefined) values.add(value);
    }
  }
}

export function evalIdentities(identities: EvalAgentIdentities): EvalIdentities { return identities; }

export function evalMetrics(metrics: EvalAgentMetrics): Partial<EvalMetrics> {
  const costGroups = metrics.costs;
  const currencies = new Set(costGroups.map(cost => cost.currency));
  const known = costGroups.filter(cost => cost.amount !== undefined);
  const complete = metrics.coverageComplete && costGroups.length > 0 && currencies.size === 1 && costGroups.every(cost => cost.complete);
  const missingReasons = [...new Set(costGroups.flatMap(cost => cost.missingReasons))];
  if (costGroups.length === 0) missingReasons.push("model-cost-telemetry-missing");
  if (currencies.size > 1) missingReasons.push("multiple-currencies");
  if (!metrics.coverageComplete) missingReasons.push(...metrics.coverageMissingReasons);
  const kinds = new Set(costGroups.map(cost => cost.kind));
  const count = (value: number): MeasuredValue => ({ value, complete: metrics.coverageComplete, missingReasons: metrics.coverageMissingReasons });
  return {
    approvalWaitMs: count(metrics.approvalWaitMs), modelCalls: count(metrics.modelCalls),
    modelAttempts: { ...count(metrics.modelAttempts), complete: metrics.coverageComplete && metrics.modelAttemptsComplete,
      missingReasons: [...metrics.coverageMissingReasons, ...(metrics.modelAttemptsComplete ? [] : ["native-compaction-attempt-count-unavailable"])] }, retryWaitMs: count(metrics.retryWaitMs),
    toolCalls: count(metrics.toolCalls), toolFailures: count(metrics.toolFailures),
    contextCompactions: count(metrics.contextCompactions), humanInterventions: count(metrics.humanInterventions),
    totalTokens: { ...(metrics.tokens.totalTokens === undefined ? {} : { value: metrics.tokens.totalTokens }), complete: metrics.tokens.complete, missingReasons: metrics.tokens.missingReasons },
    cost: { ...(known.length === 0 || currencies.size !== 1 ? {} : { amount: known.reduce((sum, cost) => sum + cost.amount!, 0) }),
      currency: currencies.size === 1 ? costGroups[0]!.currency : "USD", kind: kinds.size === 1 ? costGroups[0]!.kind : "estimated",
      complete, missingReasons,
      ...(costGroups.length === 1 && costGroups[0]!.pricingId !== undefined ? { pricingId: costGroups[0]!.pricingId } : {}),
      ...(costGroups.length === 1 && costGroups[0]!.pricingVersion !== undefined ? { pricingVersion: costGroups[0]!.pricingVersion } : {}),
      ...(costGroups.length === 1 && costGroups[0]!.source !== undefined ? { source: costGroups[0]!.source } : {}),
      ...(costGroups.length === 1 && costGroups[0]!.effectiveAt !== undefined ? { effectiveAt: costGroups[0]!.effectiveAt } : {}),
    },
  };
}

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
  return {
    taskId: identities?.taskIds.length === 1 ? identities.taskIds[0]! : options.trialId,
    evaluator: options.evaluatorId, evaluatorVersion: options.evaluatorVersion, result: options.verdict,
    ...(options.configurationVersion === undefined ? {} : { configurationVersion: options.configurationVersion }),
    ...(identities?.sessionIds.length === 1 ? { sessionId: identities.sessionIds[0]! } : {}),
    ...(identities?.runIds.length === 1 ? { runId: identities.runIds[0]! } : {}),
    ...(identities?.coordinationIds.length === 1 ? { coordinationId: identities.coordinationIds[0]! } : {}),
    ...(identities?.traceIds.length === 1 ? { traceId: identities.traceIds[0]! } : {}),
    ...(options.evidenceReferences === undefined ? {} : { evidenceReferences: [...options.evidenceReferences] }),
    timestamp: options.timestamp ?? Date.now(),
  };
}

function text(attributes: TraceAttributes, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

function numeric(attributes: TraceAttributes, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function spanUsage(attributes: TraceAttributes): Usage | undefined {
  const inputTokens = numeric(attributes, "may.model.input_tokens");
  const outputTokens = numeric(attributes, "may.model.output_tokens");
  const totalTokens = numeric(attributes, "may.model.total_tokens");
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return { ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    completeness: { status: attributes["may.model.usage_complete"] === true ? "complete" : "partial", ...(attributes["may.model.usage_complete"] === true ? {} : { reason: "model-call-usage-incomplete" }) } };
}
