import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { FileSharedBudget, sharedBudgetTotals, type CoordinationSnapshot, type SharedBudgetLimits, type SharedBudgetSnapshot } from "@may/coordination";
import { FileCoordinationStore } from "@may/coordination/file-store";
import type { Usage } from "@may/core";
import { FileSessionStore } from "@may/session/file-store";
import { TeamVerificationStore } from "./team-verification.js";

export type TeamResolution =
  | { readonly format: 1; readonly kind: "task"; readonly taskId: string; readonly outcome: "failed" | "cancelled"; readonly finding: string }
  | { readonly format: 1; readonly kind: "budget"; readonly callId: string; readonly usage: Usage; readonly finding: string }
  | { readonly format: 1; readonly kind: "check"; readonly commandId: string; readonly outcome: "failed" | "cancelled"; readonly finding: string };

export async function readTeamResolution(path: string): Promise<TeamResolution> {
  const file = await open(path, "r");
  let value: unknown;
  try {
    if (!(await file.stat()).isFile() || (await file.stat()).size > 32_768) throw new Error("Resolution file exceeds 32768 bytes");
    const bytes = await file.readFile();
    if (bytes.length > 32_768) throw new Error("Resolution file exceeds 32768 bytes");
    value = JSON.parse(bytes.toString("utf8"));
  } finally { await file.close(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Resolution must be an object");
  const input = value as Record<string, unknown>;
  if (input.format !== 1 || !["task", "budget", "check"].includes(input.kind as string) || typeof input.finding !== "string" || !input.finding.trim() || input.finding.length > (input.kind === "budget" ? 256 : 8192) || /[\u0000-\u001f]/u.test(input.finding)) throw new Error("Resolution requires format 1, a supported kind, and bounded verified finding");
  const keys = input.kind === "budget" ? ["callId", "usage"] : [input.kind === "task" ? "taskId" : "commandId", "outcome"];
  if (Object.keys(input).some((key) => !["format", "kind", "finding", ...keys].includes(key))) throw new Error("Unknown resolution field");
  const id = input[keys[0]!];
  if (typeof id !== "string" || !id.length || id.length > 256 || /[\u0000-\u001f]/u.test(id)) throw new Error("Invalid resolution identity");
  if (input.kind === "budget") {
    const usage = input.usage as Record<string, unknown>;
    if (!usage || typeof usage !== "object" || Array.isArray(usage) || Object.keys(usage).some((key) => !["inputTokens", "outputTokens", "totalTokens"].includes(key)) || !Object.keys(usage).length || Object.values(usage).some((n) => !Number.isSafeInteger(n) || (n as number) < 0) || (usage.totalTokens === undefined && (usage.inputTokens === undefined || usage.outputTokens === undefined))) throw new Error("Supply verified non-negative token usage; do not estimate unknown usage as zero");
  } else if (!["failed", "cancelled"].includes(input.outcome as string)) throw new Error("Reconciliation cannot manufacture a successful answer/check");
  return input as unknown as TeamResolution;
}

/** Review confirmation binds data and identities, not a bare yes/no or model approval. */
export function teamReviewDigest(value: unknown): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export function retryImpact(state: CoordinationSnapshot, taskId: string, finding: string) {
  if (!finding.trim() || finding.length > 8192) throw new Error("A bounded verified retry finding is required");
  const task = state.tasks.find((task) => task.id === taskId);
  if (!task) throw new Error("Unknown retry task");
  const affected = new Set([taskId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const candidate of state.tasks) if (!affected.has(candidate.id) && candidate.dependsOn.some((id) => affected.has(id))) { affected.add(candidate.id); changed = true; }
  }
  return { taskId, status: task.status, attempt: task.attempt ?? 0, nextAttempt: (task.attempt ?? 0) + 1,
    finding, affectedDependants: state.tasks.filter((task) => task.id !== taskId && affected.has(task.id)).map(({ id, status }) => ({ id, status })),
    children: state.tasks.filter((task) => task.parentTaskId === taskId).map(({ id, status }) => ({ id, status })),
    note: "Only this task receives a new Session/dispatch. No effects, budget, workspace edits or dependant failures are rolled back. Resume is separate; runtime safety checks still apply." };
}

export async function inspectTeam(directory: string, id: string, limits: SharedBudgetLimits): Promise<string> {
  const state = await optional(() => new FileCoordinationStore(join(directory, "coordination")).inspect(id));
  const budget = await optional(() => FileSharedBudget.inspect(join(directory, "budget"), id, limits));
  const verification = await optional(() => TeamVerificationStore.inspect(join(directory, "verification")));
  const lines = ["Read-only monitoring snapshot (not an atomic view across journals)."];
  if (!state) lines.push("No execution snapshot yet.");
  else {
    lines.push(`Revision ${state.revision}${state.stopReason ? `; stopped: ${state.stopReason}` : ""}`);
    const sessions = new FileSessionStore(join(directory, "sessions"));
    for (const task of state.tasks) {
      lines.push(`${task.id}: ${task.status}; attempt ${task.attempt ?? 0}; session ${task.sessionId}`);
      if (task.detail) lines.push(`  Reason: ${task.detail}`);
      const blocked = task.dependsOn.filter((id) => state.tasks.find((candidate) => candidate.id === id)?.status !== "completed");
      if (blocked.length) lines.push(`  Unsuccessful dependencies: ${blocked.join(", ")}`);
      if (["failed", "cancelled", "recovery-required", "cancelling"].includes(task.status)) {
        const events = await sessions.read(task.sessionId);
        const pending = new Map<string, string>();
        for (const event of events) {
          if (event.type === "tool.started") pending.set(`${event.runId}:${event.step}:${event.call.id}`, event.call.name);
          if (event.type === "tool.completed" || (event.type === "tool.failed" && !/CANCEL|ABORT|UNKNOWN/iu.test(`${event.error.name} ${event.error.code ?? ""}`))) pending.delete(`${event.runId}:${event.step}:${event.call.id}`);
        }
        for (const [key, name] of pending) lines.push(`  Unsettled tool evidence: ${key} (${name}); inspect Session before reconciling task`);
      }
    }
  }
  if (budget) lines.push(...budgetStatus(budget));
  if (verification) {
    lines.push(`Structured reports: ${verification.reports.length}; checks: ${verification.checks.length}`);
    for (const check of verification.checks) lines.push(`  Check ${check.spec.id} (${check.taskId}): ${check.status}; command ${check.commandId}${check.detail ? `; ${check.detail}` : ""}`);
  }
  lines.push("Recovery does not steal locks, erase unknown effects, reset budgets, or execute agents.",
    "Use retry --task ... --finding ... or reconcile --resolution ... to preview; repeat with the exact --confirm digest, then resume explicitly.");
  return `${lines.join("\n")}\n`;
}

function budgetStatus(budget: SharedBudgetSnapshot): string[] {
  return [`Shared budget: ${JSON.stringify(sharedBudgetTotals(budget))}`, ...budget.calls.filter((call) => call.status !== "settled" || call.exceededReservation).map((call) =>
    `  Budget call ${call.id}: ${call.status}${call.exceededReservation ? ", exceeded reservation" : ""}; reserved ${call.reservation.totalTokens} tokens`)];
}

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try { return await read(); }
  catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
