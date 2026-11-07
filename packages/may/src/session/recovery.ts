import { omitUndefined } from "../core/index.js";
import type { SessionEvent, SessionEventPayload, SessionRecovery } from "./events.js";

/** @public */
export class SessionRecoveryRequiredError extends Error {
  readonly code = "SESSION_RECOVERY_REQUIRED";
  constructor(readonly recoveries: readonly SessionRecovery[]) {
    super("Interrupted tools have unknown outcomes. Inspect /recovery and record verified findings before continuing.");
    this.name = "SessionRecoveryRequiredError";
  }
}

export function interruptedRuns(events: readonly SessionEvent[]): SessionEventPayload[] {
  const runs = new Map<string, { version?: 1; pending: Map<string, SessionRecovery>; started: Set<string> }>();
  const approvals = new Set<string>();
  for (const event of events) {
    if (event.type === "approval.requested") approvals.add(event.request.id);
    if (event.type === "approval.resolved" || event.type === "approval.cancelled") approvals.delete(event.requestId);
    if (event.type === "run.started") {
      runs.set(event.runId, {
        ...omitUndefined({ version: event.checkpointVersion }),
        pending: new Map(),
        started: new Set(),
      });
    } else if (event.type === "assistant.completed") {
      const run = runs.get(event.runId);
      for (const call of event.message.toolCalls ?? []) {
        const id = `${event.runId}:${event.step}:${call.id}`;
        run?.pending.set(id, { id, runId: event.runId, step: event.step, call, status: "unknown" });
      }
    } else if (event.type === "tool.started") {
      runs.get(event.runId)?.started.add(`${event.runId}:${event.step}:${event.call.id}`);
    } else if (event.type === "tool.completed" || event.type === "tool.failed") {
      runs.get(event.runId)?.pending.delete(`${event.runId}:${event.step}:${event.call.id}`);
    } else if (
      event.type === "run.completed" ||
      event.type === "run.yielded" ||
      event.type === "run.cancelled" ||
      event.type === "run.interrupted"
    ) {
      runs.delete(event.runId);
    } else if (event.type === "run.failed") {
      // A failure can leave unclosed calls (e.g. a failed persistence barrier).
      if (runs.get(event.runId)?.pending.size === 0) runs.delete(event.runId);
    }
  }
  const repairs: SessionEventPayload[] = [...runs].map(([runId, run]) => ({
    type: "run.interrupted",
    runId,
    recoveries: [...run.pending.values()].map((item) => ({
      ...item,
      status: run.version === 1 && !run.started.has(item.id) ? "not-started" : "unknown",
    })),
  }));
  return [
    ...repairs,
    ...[...approvals].map((requestId) => ({
      type: "approval.cancelled" as const,
      requestId,
      reason: "Process interrupted; approval was not restored",
    })),
  ];
}
