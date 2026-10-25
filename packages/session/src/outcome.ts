import type { RunResult, SerializedError } from "@sortedyuan/core";
import type { SessionEvent } from "./events.js";
import { validateSessionHistory } from "./store.js";

export type SessionRunSelector =
  | { readonly runId: string }
  | { readonly inputId: string }
  | { readonly inputSeq: number }
  | { readonly continuationId: string };

export type SessionRunOutcome =
  | { readonly status: "not-started" }
  | { readonly status: "completed"; readonly result: RunResult }
  | { readonly status: "yielded"; readonly result: RunResult }
  | { readonly status: "failed" | "cancelled" | "recovery-required"; readonly detail: string };

export function isSessionRunTerminalEvent(event: { readonly type: string }): boolean {
  return ["run.completed", "run.yielded", "run.failed", "run.cancelled", "run.interrupted"].includes(event.type);
}

export function sessionToolFailureHasUnknownEffects(error: Pick<SerializedError, "name" | "code">): boolean {
  return /CANCEL|ABORT|UNKNOWN/iu.test(`${error.code ?? ""} ${error.name}`);
}

/** 根据持久身份查询一个 Run；查询本身只读取事件。 */
export function inspectSessionRunOutcome(
  history: readonly SessionEvent[],
  selector: SessionRunSelector,
): SessionRunOutcome {
  const keys = Object.keys(selector);
  if (keys.length !== 1 || !["runId", "inputId", "inputSeq", "continuationId"].includes(keys[0]!)) {
    throw new TypeError("Select one Session Run identity");
  }
  if ("inputSeq" in selector) {
    if (!Number.isSafeInteger(selector.inputSeq) || selector.inputSeq < 1) throw new TypeError("inputSeq must be a positive safe integer");
  } else {
    const identity = "runId" in selector ? selector.runId : "inputId" in selector ? selector.inputId : selector.continuationId;
    if (typeof identity !== "string" || identity.trim() === "") throw new TypeError("Session Run identity must be nonempty");
  }
  if (history.length === 0) return { status: "not-started" };
  validateSessionHistory(history[0]!.sessionId, history);
  let started: Extract<SessionEvent, { type: "run.started" }>[];
  if ("runId" in selector) {
    started = history.filter((event): event is Extract<SessionEvent, { type: "run.started" }> => event.type === "run.started" && event.runId === selector.runId);
    if (started.length === 0 && !history.some(event => "runId" in event && event.runId === selector.runId)) return { status: "not-started" };
  } else if ("continuationId" in selector) {
    const submissions = history.filter(event => event.type === "continuation.submitted" && event.continuationId === selector.continuationId);
    started = history.filter((event): event is Extract<SessionEvent, { type: "run.started" }> => event.type === "run.started" && event.continuationId === selector.continuationId);
    if (submissions.length === 0 && started.length === 0) return { status: "not-started" };
    if (submissions.length !== 1 || started.some(event => event.seq <= submissions[0]!.seq || event.continuation !== true)) {
      return unknownOutcome("Continuation has no unique durable submission");
    }
  } else {
    const submissions = history.filter(event => event.type === "input.submitted" &&
      ("inputId" in selector ? event.inputId === selector.inputId : event.seq === selector.inputSeq));
    if (submissions.length === 0) return { status: "not-started" };
    if (submissions.length !== 1) return unknownOutcome("Input has no unique durable submission");
    const submission = submissions[0]!;
    const next = history.find(event => event.seq > submission.seq && (event.type === "input.submitted" || event.type === "continuation.submitted"));
    started = history.filter((event): event is Extract<SessionEvent, { type: "run.started" }> => event.type === "run.started" && event.seq > submission.seq &&
      (next === undefined || event.seq < next.seq) && event.continuation !== true);
  }
  if (started.length !== 1) return unknownOutcome("Submitted request has no unique durable Run");
  const run = started[0]!;
  const unresolved = new Set<string>();
  const cancelledApprovals = new Set<string>();
  const approvals = new Map<string, string>();
  for (const event of history) {
    if (event.type === "recovery.resolved") { unresolved.delete(event.recoveryId); continue; }
    if (event.type === "approval.requested" && event.request.runId === run.runId) {
      approvals.set(event.request.id, `${run.runId}:${event.request.step}:${event.request.toolCallId}`);
    }
    if (event.type === "approval.cancelled") {
      const key = approvals.get(event.requestId);
      if (key !== undefined) { unresolved.delete(key); cancelledApprovals.add(key); }
      approvals.delete(event.requestId);
    }
    if (event.type === "approval.resolved") approvals.delete(event.requestId);
    if (!("runId" in event) || event.runId !== run.runId) continue;
    if (event.type === "tool.started") {
      const key = `${run.runId}:${event.step}:${event.call.id}`;
      unresolved.add(key); cancelledApprovals.delete(key);
    }
    if (event.type === "tool.completed") unresolved.delete(`${run.runId}:${event.step}:${event.call.id}`);
    if (event.type === "tool.failed") {
      const key = `${run.runId}:${event.step}:${event.call.id}`;
      if (sessionToolFailureHasUnknownEffects(event.error) && !cancelledApprovals.has(key)) unresolved.add(key);
      else unresolved.delete(key);
    }
    if (event.type === "run.interrupted") {
      for (const recovery of event.recoveries) if (recovery.status === "unknown") unresolved.add(recovery.id);
    }
  }
  if (unresolved.size > 0) return unknownOutcome("Interrupted tool effects require verified reconciliation");
  const terminals = history.filter(event => "runId" in event && event.runId === run.runId &&
    ["run.completed", "run.yielded", "run.failed", "run.cancelled"].includes(event.type));
  if (terminals.length !== 1 || terminals[0]!.seq <= run.seq) return unknownOutcome("Run has no unique durable terminal outcome");
  const terminal = terminals[0]!;
  if (terminal.type === "run.completed" || terminal.type === "run.yielded") {
    if (terminal.result.runId !== run.runId || (terminal.type === "run.yielded") !== (terminal.result.finishReason === "yielded")) {
      return unknownOutcome("Run result does not match its durable terminal identity");
    }
    return { status: terminal.type === "run.completed" ? "completed" : "yielded", result: structuredClone(terminal.result) };
  }
  if (terminal.type === "run.failed") return { status: "failed", detail: terminal.error.message };
  if (terminal.type === "run.cancelled") return { status: "cancelled", detail: terminal.reason ?? "Run cancelled" };
  return unknownOutcome("Run has no durable terminal outcome");
}

function unknownOutcome(detail: string): SessionRunOutcome {
  return { status: "recovery-required", detail };
}
