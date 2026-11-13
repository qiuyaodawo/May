import type { FileHandle } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import {
  identifier,
  integer,
  parseTeamCheck,
  parseTeamChecks,
  parseTeamReport,
  safeRelative,
  type TeamCheckSpec,
} from "./team-check-spec.js";
import type { StoredTeamReport, TeamCheckResult } from "./team-verification.js";

export interface Identity {
  readonly taskId: string;
  readonly coordinationId?: string;
  readonly dispatchId?: string;
  readonly turn?: number;
}
export type JournalEvent =
  | { readonly type: "config"; readonly checks: readonly TeamCheckSpec[] }
  | { readonly type: "report"; readonly report: StoredTeamReport }
  | { readonly type: "check"; readonly result: TeamCheckResult };
interface Entry {
  readonly sequence: number;
  readonly event: JournalEvent;
}
export const maxJournalBytes = 16_777_216;

export async function readJournal(file: FileHandle): Promise<{ entries: Entry[]; committed: number; size: number }> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > maxJournalBytes) throw new Error("Invalid verification journal type or size");
  const bytes = Buffer.alloc(stat.size);
  let count = 0;
  while (count < bytes.length) {
    const result = await file.read(bytes, count, bytes.length - count, count);
    if (!result.bytesRead) break;
    count += result.bytesRead;
  }
  const committed = count === 0 || bytes[count - 1] === 10 ? count : bytes.subarray(0, count).lastIndexOf(10) + 1;
  const entries: Entry[] = [];
  const reportIds = new Set<string>();
  const checkResults = new Map<string, TeamCheckResult>();
  let specs: readonly TeamCheckSpec[] = [];
  for (const line of bytes.subarray(0, committed).toString("utf8").split("\n").slice(0, -1)) {
    const entry = JSON.parse(line) as Entry;
    if (!entry || entry.sequence !== entries.length + 1 || !entry.event)
      throw new Error("Invalid verification journal sequence");
    const event = entry.event;
    if (event.type === "config") {
      if (entries.length !== 0) throw new Error("Duplicate verification config");
      specs = parseTeamChecks(event.checks);
    } else if (entries.length === 0) throw new Error("Missing verification config");
    else if (event.type === "report") {
      parseTeamReport(event.report.report);
      validateStored(event.report);
      if (reportIds.size >= 256 || reportIds.has(event.report.commandId) || !Array.isArray(event.report.evidence))
        throw new Error("Invalid stored report history");
      for (const item of event.report.evidence) {
        safeRelative(item.path);
        integer(item.startLine, 1, 1000000, "stored evidence startLine");
        integer(item.endLine, item.startLine, 1000000, "stored evidence endLine");
        if (typeof item.valid !== "boolean" || (item.valid && !/^[a-f0-9]{64}$/u.test(item.sha256 ?? "")))
          throw new Error("Invalid stored evidence");
      }
      reportIds.add(event.report.commandId);
    } else if (event.type === "check") {
      const result = event.result;
      parseTeamCheck(result.spec);
      validateStored(result);
      if (
        !isDeepStrictEqual(
          specs.find((entry) => entry.id === result.spec.id),
          result.spec,
        ) ||
        result.taskId !== result.spec.taskId ||
        !["pending", "passed", "failed", "unknown", "cancelled"].includes(result.status) ||
        (result.afterFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(result.afterFingerprint))
      )
        throw new Error("Invalid check record");
      const old = checkResults.get(result.commandId);
      if (!old) {
        if (checkResults.size >= 512 || result.status !== "pending")
          throw new Error("Check result has no pending intent");
      } else {
        if (
          !sameIdentity(old, result) ||
          !isDeepStrictEqual(old.spec, result.spec) ||
          old.workspaceFingerprint !== result.workspaceFingerprint ||
          (old.status !== "pending" && old.status !== "unknown") ||
          result.status === "pending" ||
          (old.status === "unknown" && (!["failed", "cancelled"].includes(result.status) || !result.reconciliation))
        )
          throw new Error("Invalid check history transition");
      }
      checkResults.set(result.commandId, result);
    } else throw new Error("Unknown verification journal record");
    entries.push(entry);
  }
  return { entries, committed, size: stat.size };
}
function validateStored(value: StoredTeamReport | TeamCheckResult): void {
  identifier(value.commandId, "stored command id");
  identifier(value.taskId, "stored task id");
  if (!/^[a-f0-9]{64}$/u.test(value.workspaceFingerprint)) throw new Error("Invalid stored workspace fingerprint");
}
export function sameIdentity(a: Identity, b: Identity): boolean {
  return (
    a.taskId === b.taskId && a.coordinationId === b.coordinationId && a.dispatchId === b.dispatchId && a.turn === b.turn
  );
}
