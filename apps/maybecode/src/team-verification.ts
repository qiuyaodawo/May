import { acquireFileLock, hasErrorCode, type FileLock } from "@sortedyuan/may/storage";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, type FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AsyncStateSerializer } from "@sortedyuan/may/core";
import type { TaskExecution } from "@sortedyuan/coordination";
import type { Tool } from "@sortedyuan/may/core";
import type { CodingExecutionEnvironment } from "@sortedyuan/coding-tools";
import {
  boundedString,
  identifier,
  parseTeamCheck,
  parseTeamChecks,
  parseTeamReport,
  type TeamCheckSpec,
  type TeamReport,
} from "./team-check-spec.js";
import { hash, message, noFollow, readWorkspaceFile, runCommand, workspaceFingerprint } from "./team-check-runner.js";
import { createTeamVerificationTools } from "./team-verification-tools.js";
import {
  maxJournalBytes,
  readJournal,
  sameIdentity,
  type Identity,
  type JournalEvent,
} from "./team-verification-journal.js";

export interface StoredTeamReport extends Identity {
  readonly commandId: string;
  readonly report: TeamReport;
  readonly workspaceFingerprint: string;
  readonly evidence: readonly {
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly sha256?: string;
    readonly valid: boolean;
    readonly detail?: string;
  }[];
}
export interface TeamCheckResult extends Identity {
  readonly commandId: string;
  readonly spec: TeamCheckSpec;
  readonly workspaceFingerprint: string;
  readonly afterFingerprint?: string;
  readonly status: "pending" | "passed" | "failed" | "unknown" | "cancelled";
  readonly detail?: string;
  readonly exitCode?: number;
  readonly output?: string;
  readonly reconciliation?: string;
}
export interface TeamVerificationSnapshot {
  readonly reports: readonly StoredTeamReport[];
  readonly checks: readonly TeamCheckResult[];
}
export interface TeamAcceptance {
  readonly status: "passed" | "failed" | "unverified";
  readonly workspaceFingerprint: string;
  readonly checks: readonly {
    readonly id: string;
    readonly status: TeamCheckResult["status"] | "missing" | "stale";
    readonly commandId?: string;
    readonly detail?: string;
  }[];
  readonly report?: StoredTeamReport;
  readonly detail: string;
}
export interface TeamCheckOptions {
  readonly allowCommands?: boolean;
  readonly signal?: AbortSignal;
  readonly execution?: TaskExecution;
}

/** Host evidence and deterministic checks; a model report can never grant acceptance. */
export class TeamVerificationStore {
  private readonly serial = new AsyncStateSerializer();
  private readonly reports: StoredTeamReport[] = [];
  private readonly results = new Map<string, TeamCheckResult>();
  private sequence = 0;
  private size = 0;
  private failed = false;
  private closing?: Promise<void>;
  private readonly active = new Set<Promise<unknown>>();
  private constructor(
    private readonly file: FileHandle,
    private readonly lock: FileLock,
    private readonly checks: readonly TeamCheckSpec[],
    private readonly executionFor?: (workspace: string) => Promise<CodingExecutionEnvironment>,
  ) {}

  static async open(options: {
    readonly directory: string;
    readonly checks?: readonly TeamCheckSpec[];
    readonly executionFor?: (workspace: string) => Promise<CodingExecutionEnvironment>;
  }): Promise<TeamVerificationStore> {
    const checks = parseTeamChecks(options.checks ?? []);
    await mkdir(options.directory, { recursive: true });
    if ((await lstat(options.directory)).isSymbolicLink())
      throw new Error("Verification directory must not be a symbolic link");
    const path = join(await realpath(options.directory), "verification.jsonl");
    const lock = await acquireFileLock(`${path}.lock`);
    let file: FileHandle | undefined;
    try {
      await rejectLinkIfPresent(path);
      file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | noFollow(), 0o600);
      const { entries, committed, size } = await readJournal(file);
      if (committed !== size) {
        // Windows append-only handles cannot truncate; keep ownership and use a repair handle.
        const repair = await open(path, constants.O_RDWR | noFollow());
        try {
          await repair.truncate(committed);
          await repair.sync();
        } finally {
          await repair.close();
        }
      }
      const store = new TeamVerificationStore(file, lock, checks, options.executionFor);
      store.size = committed;
      for (const entry of entries) {
        store.apply(entry.event);
        store.sequence = entry.sequence;
      }
      if (
        entries.length &&
        !isDeepStrictEqual((entries[0]!.event as { checks: readonly TeamCheckSpec[] }).checks, checks)
      )
        throw new Error("Verification checks changed on resume");
      if (!entries.length) await store.append({ type: "config", checks });
      // No command, test, or other effect is replayed during recovery.
      for (const result of store.results.values())
        if (result.status === "pending") {
          await store.append({
            type: "check",
            result: {
              ...result,
              status: "unknown",
              detail: "Interrupted check; inspect effects and reconcile before a new command.",
            },
          });
        }
      return store;
    } catch (error) {
      try {
        await file?.close();
      } finally {
        await lock.release();
      }
      throw error;
    }
  }

  /** Read-only status inspection, including while a writer owns the journal. */
  static async inspect(directory: string): Promise<TeamVerificationSnapshot> {
    const path = join(resolve(directory), "verification.jsonl");
    await rejectLinkIfPresent(path);
    let file: FileHandle;
    try {
      file = await open(path, constants.O_RDONLY | noFollow());
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { reports: [], checks: [] };
      throw error;
    }
    try {
      const { entries } = await readJournal(file);
      const reports: StoredTeamReport[] = [];
      const checks = new Map<string, TeamCheckResult>();
      for (const { event } of entries) {
        if (event.type === "report") reports.push(event.report);
        if (event.type === "check") checks.set(event.result.commandId, event.result);
      }
      return { reports, checks: [...checks.values()] };
    } finally {
      await file.close();
    }
  }

  snapshot(): Promise<TeamVerificationSnapshot> {
    return this.serial.run(() => {
      this.assertOpen();
      return structuredClone({ reports: this.reports, checks: [...this.results.values()] });
    });
  }

  forTask(execution: TaskExecution, workspace: string, options: { readonly allowCommands?: boolean } = {}) {
    const identity = taskIdentity(execution);
    const submit = (commandId: string, report: TeamReport) => this.submit(identity, commandId, report, workspace);
    const runCheck = (commandId: string, id: string, extra: { readonly signal?: AbortSignal } = {}) => {
      const spec = this.checks.find((entry) => entry.id === id && entry.taskId === identity.taskId);
      if (!spec) throw new Error("Check is not configured for this task");
      return this.runCheck(commandId, spec, workspace, { ...options, ...extra, execution });
    };
    const tools = (): readonly Tool[] => createTeamVerificationTools(this.checks, identity.taskId, submit, runCheck);
    return { submit, runCheck, tools };
  }

  runCheck(
    commandId: string,
    input: TeamCheckSpec,
    workspace: string,
    options: TeamCheckOptions = {},
  ): Promise<TeamCheckResult> {
    const work = this.executeCheck(commandId, input, workspace, options);
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  /** Host reconciliation never invents a passing result and never executes a command. */
  async reconcile(
    commandId: string,
    outcome: { readonly status: "failed" | "cancelled" },
    evidence: string,
  ): Promise<TeamCheckResult> {
    boundedString(evidence, "reconciliation evidence", 8192);
    if (outcome.status !== "failed" && outcome.status !== "cancelled")
      throw new Error("Reconciliation cannot grant acceptance");
    return this.serial.run(async () => {
      this.assertOpen();
      const current = this.results.get(commandId);
      if (!current) throw new Error("Unknown check command");
      if (current.reconciliation) {
        if (current.status !== outcome.status || current.reconciliation !== evidence)
          throw new Error("Reconciliation already recorded differently");
        return structuredClone(current);
      }
      if (current.status !== "unknown")
        throw new Error("Only an unknown check can be reconciled; an active pending check must first stop");
      const result = { ...current, status: outcome.status, reconciliation: evidence };
      await this.write({ type: "check", result });
      return structuredClone(result);
    });
  }

  async acceptance(taskId: string, workspace: string, execution?: TaskExecution): Promise<TeamAcceptance> {
    const fingerprint = await workspaceFingerprint(workspace);
    const state = await this.snapshot();
    const identity = execution ? taskIdentity(execution) : undefined;
    const report = state.reports
      .filter((entry) => entry.taskId === taskId && (!identity || sameIdentity(entry, identity)))
      .at(-1);
    const checks = this.checks
      .filter((spec) => spec.taskId === taskId)
      .map((spec) => {
        const result = state.checks
          .filter(
            (entry) =>
              entry.spec.id === spec.id &&
              (!identity || entry.dispatchId === undefined || sameIdentity(entry, identity)),
          )
          .at(-1);
        if (!result) return { id: spec.id, status: "missing" as const };
        const stale = result.workspaceFingerprint !== fingerprint || result.afterFingerprint !== fingerprint;
        return {
          id: spec.id,
          status: stale && !["pending", "unknown"].includes(result.status) ? ("stale" as const) : result.status,
          commandId: result.commandId,
          ...(result.detail ? { detail: result.detail } : {}),
        };
      });
    const currentReport = report?.workspaceFingerprint === fingerprint;
    const badEvidence = currentReport && report.evidence.some((item) => !item.valid);
    const status =
      badEvidence || checks.some((item) => item.status === "failed" || item.status === "cancelled")
        ? "failed"
        : currentReport && checks.length > 0 && checks.every((item) => item.status === "passed")
          ? "passed"
          : "unverified";
    return {
      status,
      workspaceFingerprint: fingerprint,
      checks,
      ...(report ? { report } : {}),
      detail:
        status === "passed"
          ? "Configured checks passed for these exact workspace bytes. Evidence locations are valid; claim logic and untested behavior remain unverified."
          : status === "failed"
            ? "A configured check or submitted evidence failed. Execution completion does not imply acceptance."
            : "A current structured report and all configured checks are required. Missing, stale, interrupted, or absent checks cannot grant acceptance.",
    };
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await Promise.allSettled([...this.active]);
      await this.serial.close();
      try {
        await this.file.close();
      } finally {
        await this.lock.release();
      }
    })());
  }

  private async submit(
    identity: Identity,
    commandId: string,
    input: TeamReport,
    workspace: string,
  ): Promise<StoredTeamReport> {
    identifier(commandId, "report command id");
    const report = parseTeamReport(input);
    return this.serial.run(async () => {
      this.assertOpen();
      const old = this.reports.find((entry) => entry.commandId === commandId);
      if (old) {
        if (!sameIdentity(old, identity) || !isDeepStrictEqual(old.report, report))
          throw new Error("Report command already used with different content or identity");
        return structuredClone(old);
      }
      if (this.reports.length >= 256) throw new Error("Report quota exceeded");
      const fingerprint = await workspaceFingerprint(workspace);
      const evidence: StoredTeamReport["evidence"][number][] = [];
      for (const claim of report.claims)
        for (const item of claim.evidence ?? []) {
          try {
            const bytes = await readWorkspaceFile(workspace, item.path);
            const lines = bytes.toString("utf8").replace(/\r\n/gu, "\n").split("\n");
            if (lines.at(-1) === "") lines.pop();
            const excerpt = lines.slice(item.startLine - 1, item.endLine).join("\n");
            const valid =
              item.endLine <= lines.length &&
              (item.quote === undefined || excerpt.includes(item.quote.replace(/\r\n/gu, "\n")));
            evidence.push({
              path: item.path,
              startLine: item.startLine,
              endLine: item.endLine,
              sha256: hash(bytes),
              valid,
              ...(!valid ? { detail: "Line range or quote does not match the file" } : {}),
            });
          } catch (error) {
            evidence.push({
              path: item.path,
              startLine: item.startLine,
              endLine: item.endLine,
              valid: false,
              detail: message(error),
            });
          }
        }
      if ((await workspaceFingerprint(workspace)) !== fingerprint)
        throw new Error("Workspace changed while validating report evidence");
      const stored = { ...identity, commandId, report, workspaceFingerprint: fingerprint, evidence };
      await this.write({ type: "report", report: stored });
      return structuredClone(stored);
    });
  }

  private async executeCheck(
    commandId: string,
    input: TeamCheckSpec,
    workspace: string,
    options: TeamCheckOptions,
  ): Promise<TeamCheckResult> {
    identifier(commandId, "check command id");
    const spec = parseTeamCheck(input);
    const configured = this.checks.find((entry) => entry.id === spec.id);
    if (!isDeepStrictEqual(configured, spec)) throw new Error("Check is not the exact host-configured specification");
    const identity: Identity = options.execution ? taskIdentity(options.execution) : { taskId: spec.taskId };
    if (identity.taskId !== spec.taskId) throw new Error("Check belongs to a different task");
    let fresh = false;
    const pending = await this.serial.run(async () => {
      this.assertOpen();
      const old = this.results.get(commandId);
      if (old) {
        if (!isDeepStrictEqual(old.spec, spec) || !sameIdentity(old, identity))
          throw new Error("Check command already used with different specification or identity");
        return structuredClone(old);
      }
      if (this.results.size >= 512) throw new Error("Check quota exceeded");
      if (
        [...this.results.values()].some(
          (entry) => entry.taskId === spec.taskId && ["unknown", "pending"].includes(entry.status),
        )
      )
        throw new Error("Task has a pending or unknown check; inspect and reconcile before another check");
      if (spec.type === "command" && options.allowCommands !== true)
        throw new Error("Command checks require explicit --allow-checks authorization");
      options.signal?.throwIfAborted();
      const result: TeamCheckResult = {
        ...identity,
        commandId,
        spec,
        workspaceFingerprint: await workspaceFingerprint(workspace),
        status: "pending",
      };
      await this.write({ type: "check", result });
      fresh = true;
      return result;
    });
    if (!fresh) return pending;
    let outcome: Pick<TeamCheckResult, "status" | "detail" | "exitCode" | "output">;
    try {
      if (spec.type === "command") outcome = await runCommand(spec, workspace, options.signal, this.executionFor);
      else {
        options.signal?.throwIfAborted();
        const bytes = await readWorkspaceFile(workspace, spec.path);
        const passed =
          spec.type === "file-sha256" ? hash(bytes) === spec.sha256 : bytes.toString("utf8").includes(spec.text);
        outcome = {
          status: passed ? "passed" : "failed",
          detail: passed ? "Exact configured file check passed" : "Configured file predicate did not match",
        };
      }
    } catch (error) {
      outcome = { status: spec.type === "command" ? "unknown" : "failed", detail: message(error) };
    }
    let afterFingerprint: string | undefined;
    try {
      afterFingerprint = await workspaceFingerprint(workspace);
    } catch (error) {
      outcome = {
        ...outcome,
        status: spec.type === "command" ? "unknown" : "failed",
        detail: `Cannot inspect workspace after check: ${message(error)}`,
      };
    }
    const result: TeamCheckResult = { ...pending, ...outcome, ...(afterFingerprint ? { afterFingerprint } : {}) };
    await this.append({ type: "check", result });
    return structuredClone(result);
  }

  private append(event: JournalEvent): Promise<void> {
    return this.serial.run(() => this.write(event));
  }
  private async write(event: JournalEvent): Promise<void> {
    this.assertOpen();
    const line = `${JSON.stringify({ sequence: this.sequence + 1, event })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes + this.size > maxJournalBytes) throw new Error("Verification journal quota exceeded");
    try {
      await this.file.writeFile(line);
      await this.file.sync();
    } catch (error) {
      this.failed = true;
      throw error;
    }
    this.sequence++;
    this.size += bytes;
    this.apply(event);
  }
  private apply(event: JournalEvent): void {
    if (event.type === "report") this.reports.push(event.report);
    if (event.type === "check") this.results.set(event.result.commandId, event.result);
  }
  private assertOpen(): void {
    if (this.failed) throw new Error("Verification write outcome unknown; close and inspect before continuing");
  }
}

function taskIdentity(execution: TaskExecution): Identity {
  return {
    taskId: execution.task.id,
    coordinationId: execution.coordinationId,
    dispatchId: execution.task.dispatchId,
    turn: execution.task.turn ?? 0,
  };
}
async function rejectLinkIfPresent(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Verification file must not be a symbolic link");
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}
