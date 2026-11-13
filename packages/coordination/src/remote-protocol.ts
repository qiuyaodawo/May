import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AgentApplicationEvent } from "@sortedyuan/may";
import type { TaskExecution, TaskRecovery } from "./types.js";
import { canonical, copy, freeze, validateOutput } from "./validation.js";

export interface Dispatch {
  readonly agent: string;
  readonly execution: TaskExecution;
}
export interface Job extends Dispatch {
  readonly id: string;
  readonly fingerprint: string;
  readonly status: "queued" | "running" | "terminal";
  readonly cancelRequested?: boolean;
  readonly outcome?: TaskRecovery;
}
export interface JobView {
  readonly id: string;
  readonly status: Job["status"];
  readonly outcome?: TaskRecovery;
  readonly events: readonly { seq: number; event: AgentApplicationEvent }[];
  readonly cursor: number;
}

export function dispatchId(execution: TaskExecution): string {
  return createHash("sha256")
    .update(
      canonical([execution.coordinationId, execution.task.id, execution.task.dispatchId, execution.task.turn ?? 0]),
    )
    .digest("hex");
}
export function fingerprint(dispatch: Dispatch): string {
  const {
    status: _status,
    detail: _detail,
    cancelRequested: _cancel,
    output: _output,
    ...task
  } = dispatch.execution.task;
  const { telemetry: _telemetry, ...execution } = dispatch.execution;
  return createHash("sha256")
    .update(canonical({ agent: dispatch.agent, execution: { ...execution, task } }))
    .digest("hex");
}
export function validateOutcome(outcome: TaskRecovery): TaskRecovery {
  if (!outcome || !["not-started", "completed", "failed", "cancelled", "recovery-required"].includes(outcome.status))
    throw new Error("Invalid remote outcome");
  if (outcome.status === "completed") validateOutput(outcome.output, 1_048_576);
  else if (outcome.status !== "not-started" && (!("detail" in outcome) || typeof outcome.detail !== "string"))
    throw new Error("Invalid remote outcome detail");
  return freeze(copy(outcome));
}
export function validateToken(token: string): void {
  if (typeof token !== "string" || token.length < 24 || /\s/u.test(token))
    throw new Error("Worker token must contain at least 24 non-whitespace characters");
}
export async function body(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw new Error("Request too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
