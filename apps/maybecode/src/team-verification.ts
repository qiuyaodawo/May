import { acquireFileLock, releaseFileLock } from "@may/session/file-store";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AsyncStateSerializer } from "@may/application";
import type { TaskExecution } from "@may/coordination";
import type { Tool } from "@may/core";

export type TeamCheckSpec =
  | { readonly id: string; readonly taskId: string; readonly type: "file-contains"; readonly path: string; readonly text: string }
  | { readonly id: string; readonly taskId: string; readonly type: "file-sha256"; readonly path: string; readonly sha256: string }
  | { readonly id: string; readonly taskId: string; readonly type: "command"; readonly command: string; readonly args: readonly string[]; readonly timeoutMs?: number; readonly maxOutputBytes?: number };

export interface TeamEvidence { readonly path: string; readonly startLine: number; readonly endLine: number; readonly quote?: string }
export interface TeamReport { readonly summary: string; readonly claims: readonly { readonly text: string; readonly kind: "finding" | "proposal"; readonly evidence?: readonly TeamEvidence[] }[] }
interface Identity { readonly taskId: string; readonly coordinationId?: string; readonly dispatchId?: string; readonly turn?: number }
export interface StoredTeamReport extends Identity {
  readonly commandId: string; readonly report: TeamReport; readonly workspaceFingerprint: string;
  readonly evidence: readonly { readonly path: string; readonly startLine: number; readonly endLine: number; readonly sha256?: string; readonly valid: boolean; readonly detail?: string }[];
}
export interface TeamCheckResult extends Identity {
  readonly commandId: string; readonly spec: TeamCheckSpec; readonly workspaceFingerprint: string;
  readonly afterFingerprint?: string; readonly status: "pending" | "passed" | "failed" | "unknown" | "cancelled";
  readonly detail?: string; readonly exitCode?: number; readonly output?: string; readonly reconciliation?: string;
}
export interface TeamVerificationSnapshot { readonly reports: readonly StoredTeamReport[]; readonly checks: readonly TeamCheckResult[] }
export interface TeamAcceptance {
  readonly status: "passed" | "failed" | "unverified"; readonly workspaceFingerprint: string;
  readonly checks: readonly { readonly id: string; readonly status: TeamCheckResult["status"] | "missing" | "stale"; readonly commandId?: string; readonly detail?: string }[];
  readonly report?: StoredTeamReport; readonly detail: string;
}
export interface TeamCheckOptions { readonly allowCommands?: boolean; readonly signal?: AbortSignal; readonly execution?: TaskExecution }
type JournalEvent = { readonly type: "config"; readonly checks: readonly TeamCheckSpec[] }
  | { readonly type: "report"; readonly report: StoredTeamReport }
  | { readonly type: "check"; readonly result: TeamCheckResult };
interface Entry { readonly sequence: number; readonly event: JournalEvent }
const maxJournalBytes = 16_777_216;

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
  private constructor(private readonly file: FileHandle, private readonly lock: FileHandle,
    private readonly lockPath: string, private readonly checks: readonly TeamCheckSpec[]) {}

  static async open(options: { readonly directory: string; readonly checks?: readonly TeamCheckSpec[] }): Promise<TeamVerificationStore> {
    const checks = parseTeamChecks(options.checks ?? []);
    await mkdir(options.directory, { recursive: true });
    if ((await lstat(options.directory)).isSymbolicLink()) throw new Error("Verification directory must not be a symbolic link");
    const path = join(await realpath(options.directory), "verification.jsonl");
    const lockPath = `${path}.lock`;
    const lock = await acquireFileLock(lockPath);
    let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
      await rejectLinkIfPresent(path);
      file = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | noFollow(), 0o600);
      const { entries, committed, size } = await readJournal(file);
      if (committed !== size) {
        // Windows append-only handles cannot truncate; keep ownership and use a repair handle.
        const repair = await open(path, constants.O_RDWR | noFollow());
        try { await repair.truncate(committed); await repair.sync(); }
        finally { await repair.close(); }
      }
      const store = new TeamVerificationStore(file, lock, lockPath, checks);
      store.size = committed;
      for (const entry of entries) { store.apply(entry.event); store.sequence = entry.sequence; }
      if (entries.length && !isDeepStrictEqual((entries[0]!.event as { checks: readonly TeamCheckSpec[] }).checks, checks)) throw new Error("Verification checks changed on resume");
      if (!entries.length) await store.append({ type: "config", checks });
      // No command, test, or other effect is replayed during recovery.
      for (const result of store.results.values()) if (result.status === "pending") {
        await store.append({ type: "check", result: { ...result, status: "unknown", detail: "Interrupted check; inspect effects and reconcile before a new command." } });
      }
      return store;
    } catch (error) { await file?.close().catch(() => undefined); await releaseFileLock(lock, lockPath); throw error; }
  }

  /** Read-only status inspection, including while a writer owns the journal. */
  static async inspect(directory: string): Promise<TeamVerificationSnapshot> {
    const path = join(resolve(directory), "verification.jsonl");
    await rejectLinkIfPresent(path);
    let file: FileHandle;
    try { file = await open(path, constants.O_RDONLY | noFollow()); }
    catch (error) { if (isMissing(error)) return { reports: [], checks: [] }; throw error; }
    try {
      const { entries } = await readJournal(file);
      const reports: StoredTeamReport[] = []; const checks = new Map<string, TeamCheckResult>();
      for (const { event } of entries) {
        if (event.type === "report") reports.push(event.report);
        if (event.type === "check") checks.set(event.result.commandId, event.result);
      }
      return { reports, checks: [...checks.values()] };
    } finally { await file.close(); }
  }

  snapshot(): Promise<TeamVerificationSnapshot> { return this.serial.run(() => { this.assertOpen(); return structuredClone({ reports: this.reports, checks: [...this.results.values()] }); }); }

  forTask(execution: TaskExecution, workspace: string, options: { readonly allowCommands?: boolean } = {}) {
    const identity = taskIdentity(execution);
    const submit = (commandId: string, report: TeamReport) => this.submit(identity, commandId, report, workspace);
    const runCheck = (commandId: string, id: string, extra: { readonly signal?: AbortSignal } = {}) => {
      const spec = this.checks.find((entry) => entry.id === id && entry.taskId === identity.taskId);
      if (!spec) throw new Error("Check is not configured for this task");
      return this.runCheck(commandId, spec, workspace, { ...options, ...extra, execution });
    };
    const tools = (): readonly Tool[] => [{
      name: "submit_report", permissionVersion: "team-verification-v1",
      description: "Store a structured report and file/line evidence. The host validates evidence bytes, not claim correctness. This never grants acceptance.",
      inputSchema: { type: "object", additionalProperties: false, required: ["summary", "claims"], properties: {
        summary: { type: "string" }, claims: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "kind"], properties: {
          text: { type: "string" }, kind: { type: "string", enum: ["finding", "proposal"] }, evidence: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "startLine", "endLine"], properties: { path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" }, quote: { type: "string" } } } },
        } } },
      } },
      parse: parseTeamReport,
      async execute(input, call) { call.signal.throwIfAborted(); return submit(hash(call.idempotencyKey), input as TeamReport); },
    }, {
      name: "run_check", permissionVersion: "team-verification-v1",
      description: `Run one exact host-configured check by id; no model-supplied commands or arguments. Available: ${this.checks.filter((entry) => entry.taskId === identity.taskId).map((entry) => entry.id).join(", ") || "none"}. Command checks require explicit host authorization and are not sandboxed.`,
      inputSchema: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" } } },
      parse(value: unknown) { const input = fields(value, ["id"]); identifier(input.id, "check id"); return { id: input.id as string }; },
      async execute(input, call) { call.signal.throwIfAborted(); return runCheck(hash(call.idempotencyKey), (input as { id: string }).id, { signal: call.signal }); },
    }];
    return { submit, runCheck, tools };
  }

  runCheck(commandId: string, input: TeamCheckSpec, workspace: string, options: TeamCheckOptions = {}): Promise<TeamCheckResult> {
    const work = this.executeCheck(commandId, input, workspace, options);
    this.active.add(work); void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }

  /** Host reconciliation never invents a passing result and never executes a command. */
  async reconcile(commandId: string, outcome: { readonly status: "failed" | "cancelled" }, evidence: string): Promise<TeamCheckResult> {
    boundedString(evidence, "reconciliation evidence", 8192);
    if (outcome.status !== "failed" && outcome.status !== "cancelled") throw new Error("Reconciliation cannot grant acceptance");
    return this.serial.run(async () => {
      this.assertOpen();
      const current = this.results.get(commandId);
      if (!current) throw new Error("Unknown check command");
      if (current.reconciliation) {
        if (current.status !== outcome.status || current.reconciliation !== evidence) throw new Error("Reconciliation already recorded differently");
        return structuredClone(current);
      }
      if (current.status !== "unknown") throw new Error("Only an unknown check can be reconciled; an active pending check must first stop");
      const result = { ...current, status: outcome.status, reconciliation: evidence };
      await this.write({ type: "check", result }); return structuredClone(result);
    });
  }

  async acceptance(taskId: string, workspace: string, execution?: TaskExecution): Promise<TeamAcceptance> {
    const fingerprint = await workspaceFingerprint(workspace);
    const state = await this.snapshot();
    const identity = execution ? taskIdentity(execution) : undefined;
    const report = state.reports.filter((entry) => entry.taskId === taskId && (!identity || sameIdentity(entry, identity))).at(-1);
    const checks = this.checks.filter((spec) => spec.taskId === taskId).map((spec) => {
      const result = state.checks.filter((entry) => entry.spec.id === spec.id && (!identity || entry.dispatchId === undefined || sameIdentity(entry, identity))).at(-1);
      if (!result) return { id: spec.id, status: "missing" as const };
      const stale = result.workspaceFingerprint !== fingerprint || result.afterFingerprint !== fingerprint;
      return { id: spec.id, status: stale && !["pending", "unknown"].includes(result.status) ? "stale" as const : result.status, commandId: result.commandId, ...(result.detail ? { detail: result.detail } : {}) };
    });
    const currentReport = report?.workspaceFingerprint === fingerprint;
    const badEvidence = currentReport && report.evidence.some((item) => !item.valid);
    const status = badEvidence || checks.some((item) => item.status === "failed" || item.status === "cancelled") ? "failed"
      : currentReport && checks.length > 0 && checks.every((item) => item.status === "passed") ? "passed" : "unverified";
    return { status, workspaceFingerprint: fingerprint, checks, ...(report ? { report } : {}),
      detail: status === "passed" ? "Configured checks passed for these exact workspace bytes. Evidence locations are valid; claim logic and untested behavior remain unverified."
        : status === "failed" ? "A configured check or submitted evidence failed. Execution completion does not imply acceptance."
          : "A current structured report and all configured checks are required. Missing, stale, interrupted, or absent checks cannot grant acceptance." };
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      await Promise.allSettled([...this.active]); await this.serial.close();
      try { await this.file.close(); } finally { await releaseFileLock(this.lock, this.lockPath); }
    })();
  }

  private async submit(identity: Identity, commandId: string, input: TeamReport, workspace: string): Promise<StoredTeamReport> {
    identifier(commandId, "report command id"); const report = parseTeamReport(input);
    return this.serial.run(async () => {
      this.assertOpen();
      const old = this.reports.find((entry) => entry.commandId === commandId);
      if (old) { if (!sameIdentity(old, identity) || !isDeepStrictEqual(old.report, report)) throw new Error("Report command already used with different content or identity"); return structuredClone(old); }
      if (this.reports.length >= 256) throw new Error("Report quota exceeded");
      const fingerprint = await workspaceFingerprint(workspace);
      const evidence: StoredTeamReport["evidence"][number][] = [];
      for (const claim of report.claims) for (const item of claim.evidence ?? []) {
        try {
          const bytes = await readWorkspaceFile(workspace, item.path);
          const lines = bytes.toString("utf8").replace(/\r\n/gu, "\n").split("\n");
          if (lines.at(-1) === "") lines.pop();
          const excerpt = lines.slice(item.startLine - 1, item.endLine).join("\n");
          const valid = item.endLine <= lines.length && (item.quote === undefined || excerpt.includes(item.quote.replace(/\r\n/gu, "\n")));
          evidence.push({ path: item.path, startLine: item.startLine, endLine: item.endLine, sha256: hash(bytes), valid,
            ...(!valid ? { detail: "Line range or quote does not match the file" } : {}) });
        } catch (error) { evidence.push({ path: item.path, startLine: item.startLine, endLine: item.endLine, valid: false, detail: message(error) }); }
      }
      if (await workspaceFingerprint(workspace) !== fingerprint) throw new Error("Workspace changed while validating report evidence");
      const stored = { ...identity, commandId, report, workspaceFingerprint: fingerprint, evidence };
      await this.write({ type: "report", report: stored }); return structuredClone(stored);
    });
  }

  private async executeCheck(commandId: string, input: TeamCheckSpec, workspace: string, options: TeamCheckOptions): Promise<TeamCheckResult> {
    identifier(commandId, "check command id"); const spec = parseTeamCheck(input);
    const configured = this.checks.find((entry) => entry.id === spec.id);
    if (!isDeepStrictEqual(configured, spec)) throw new Error("Check is not the exact host-configured specification");
    const identity: Identity = options.execution ? taskIdentity(options.execution) : { taskId: spec.taskId };
    if (identity.taskId !== spec.taskId) throw new Error("Check belongs to a different task");
    let fresh = false;
    const pending = await this.serial.run(async () => {
      this.assertOpen();
      const old = this.results.get(commandId);
      if (old) {
        if (!isDeepStrictEqual(old.spec, spec) || !sameIdentity(old, identity)) throw new Error("Check command already used with different specification or identity");
        return structuredClone(old);
      }
      if (this.results.size >= 512) throw new Error("Check quota exceeded");
      if ([...this.results.values()].some((entry) => entry.taskId === spec.taskId && ["unknown", "pending"].includes(entry.status))) throw new Error("Task has a pending or unknown check; inspect and reconcile before another check");
      if (spec.type === "command" && options.allowCommands !== true) throw new Error("Command checks require explicit --allow-checks authorization");
      options.signal?.throwIfAborted();
      const result: TeamCheckResult = { ...identity, commandId, spec, workspaceFingerprint: await workspaceFingerprint(workspace), status: "pending" };
      await this.write({ type: "check", result }); fresh = true; return result;
    });
    if (!fresh) return pending;
    let outcome: Pick<TeamCheckResult, "status" | "detail" | "exitCode" | "output">;
    try {
      if (spec.type === "command") outcome = await runCommand(spec, workspace, options.signal);
      else {
        options.signal?.throwIfAborted();
        const bytes = await readWorkspaceFile(workspace, spec.path);
        const passed = spec.type === "file-sha256" ? hash(bytes) === spec.sha256 : bytes.toString("utf8").includes(spec.text);
        outcome = { status: passed ? "passed" : "failed", detail: passed ? "Exact configured file check passed" : "Configured file predicate did not match" };
      }
    } catch (error) { outcome = { status: spec.type === "command" ? "unknown" : "failed", detail: message(error) }; }
    let afterFingerprint: string | undefined;
    try { afterFingerprint = await workspaceFingerprint(workspace); }
    catch (error) { outcome = { ...outcome, status: spec.type === "command" ? "unknown" : "failed", detail: `Cannot inspect workspace after check: ${message(error)}` }; }
    const result: TeamCheckResult = { ...pending, ...outcome, ...(afterFingerprint ? { afterFingerprint } : {}) };
    await this.append({ type: "check", result }); return structuredClone(result);
  }

  private append(event: JournalEvent): Promise<void> { return this.serial.run(() => this.write(event)); }
  private async write(event: JournalEvent): Promise<void> {
    this.assertOpen();
    const line = `${JSON.stringify({ sequence: this.sequence + 1, event })}\n`; const bytes = Buffer.byteLength(line);
    if (bytes + this.size > maxJournalBytes) throw new Error("Verification journal quota exceeded");
    try { await this.file.writeFile(line); await this.file.sync(); }
    catch (error) { this.failed = true; throw error; }
    this.sequence++; this.size += bytes; this.apply(event);
  }
  private apply(event: JournalEvent): void {
    if (event.type === "report") this.reports.push(event.report);
    if (event.type === "check") this.results.set(event.result.commandId, event.result);
  }
  private assertOpen(): void { if (this.failed) throw new Error("Verification write outcome unknown; close and inspect before continuing"); }
}

export function parseTeamCheck(value: unknown): TeamCheckSpec {
  const raw = fields(value, ["id", "taskId", "type", "path", "text", "sha256", "command", "args", "timeoutMs", "maxOutputBytes"]);
  identifier(raw.id, "check id"); identifier(raw.taskId, "check taskId");
  if (raw.type === "file-contains") { fields(raw, ["id", "taskId", "type", "path", "text"]); safeRelative(raw.path); boundedString(raw.text, "check text", 65536); }
  else if (raw.type === "file-sha256") { fields(raw, ["id", "taskId", "type", "path", "sha256"]); safeRelative(raw.path); if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)) throw new Error("Invalid SHA-256"); }
  else if (raw.type === "command") {
    fields(raw, ["id", "taskId", "type", "command", "args", "timeoutMs", "maxOutputBytes"]);
    boundedString(raw.command, "check command", 4096);
    if (/[\u0000\r\n]/u.test(raw.command as string) || !Array.isArray(raw.args) || raw.args.length > 64 || raw.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) throw new Error("Invalid check command arguments");
    if (raw.timeoutMs !== undefined) integer(raw.timeoutMs, 1, 120000, "check timeoutMs");
    if (raw.maxOutputBytes !== undefined) integer(raw.maxOutputBytes, 1, 1048576, "check maxOutputBytes");
  } else throw new Error("Unknown check type");
  return structuredClone(raw) as unknown as TeamCheckSpec;
}

export function parseTeamChecks(value: unknown): readonly TeamCheckSpec[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Checks must be an array of at most 128 entries");
  const checks = value.map(parseTeamCheck);
  if (new Set(checks.map((entry) => entry.id)).size !== checks.length) throw new Error("Check ids must be unique");
  return checks;
}

export function parseTeamReport(value: unknown): TeamReport {
  const report = fields(value, ["summary", "claims"]); boundedString(report.summary, "report summary", 8192);
  if (!Array.isArray(report.claims) || report.claims.length > 64) throw new Error("Report claims must be an array of at most 64 entries");
  for (const value of report.claims) {
    const claim = fields(value, ["text", "kind", "evidence"]); boundedString(claim.text, "claim text", 4096);
    if (claim.kind !== "finding" && claim.kind !== "proposal") throw new Error("Invalid report claim kind");
    if (claim.evidence !== undefined) {
      if (!Array.isArray(claim.evidence) || claim.evidence.length > 16) throw new Error("Too many evidence references");
      for (const item of claim.evidence) {
        const evidence = fields(item, ["path", "startLine", "endLine", "quote"]); safeRelative(evidence.path);
        integer(evidence.startLine, 1, 1000000, "evidence startLine"); integer(evidence.endLine, evidence.startLine as number, 1000000, "evidence endLine");
        if ((evidence.endLine as number) - (evidence.startLine as number) > 1000) throw new Error("Evidence range exceeds 1001 lines");
        if (evidence.quote !== undefined) boundedString(evidence.quote, "evidence quote", 8192);
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(report)) > 65536) throw new Error("Report exceeds 64 KiB");
  return structuredClone(report) as unknown as TeamReport;
}

/** All directory/file names and file bytes count; no ignored changes can retain a green check. */
export async function workspaceFingerprint(directory: string): Promise<string> {
  const root = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Workspace root must not be a symbolic link");
  const entries: unknown[] = []; let bytes = 0; let files = 0;
  async function visit(path: string): Promise<void> {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const child = join(path, name); const stat = await lstat(child);
      const nameInRoot = relative(root, child).split(sep).join("/");
      if (++files > 10000 || stat.isSymbolicLink()) throw new Error("Workspace exceeds 10000 entries or contains a symbolic link");
      if (stat.isDirectory()) { entries.push([nameInRoot, "directory"]); await visit(child); }
      else if (stat.isFile()) {
        if ((bytes += stat.size) > 67108864) throw new Error("Workspace exceeds 64 MiB");
        const content = await readWorkspaceFile(root, nameInRoot);
        entries.push([nameInRoot, "file", content.length, hash(content)]);
      } else throw new Error("Workspace contains unsupported file type");
    }
  }
  await visit(root); return hash(JSON.stringify(entries));
}

async function readWorkspaceFile(directory: string, path: string): Promise<Buffer> {
  safeRelative(path); const root = await realpath(directory); let target = root;
  for (const part of path.replace(/\\/gu, "/").split("/")) {
    target = join(target, part); if ((await lstat(target)).isSymbolicLink()) throw new Error("Evidence/check path must not contain symbolic links");
  }
  const canonical = await realpath(target); const rel = relative(root, canonical);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Evidence/check path escapes workspace");
  const before = await lstat(target);
  if (!before.isFile() || before.size > 67108864) throw new Error("Evidence/check file is invalid or exceeds 64 MiB");
  const file = await open(target, constants.O_RDONLY | noFollow());
  try {
    const current = await file.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size) throw new Error("File changed while opening");
    const buffer = Buffer.alloc(before.size + 1); let length = 0;
    while (length < buffer.length) { const chunk = await file.read(buffer, length, buffer.length - length, length); if (!chunk.bytesRead) break; length += chunk.bytesRead; }
    const after = await file.stat();
    if (length !== before.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error("File changed while reading");
    return buffer.subarray(0, length);
  } finally { await file.close(); }
}

async function runCommand(spec: Extract<TeamCheckSpec, { type: "command" }>, workspace: string, signal?: AbortSignal): Promise<Pick<TeamCheckResult, "status" | "detail" | "exitCode" | "output">> {
  signal?.throwIfAborted();
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(spec.command)) return { status: "failed", detail: "Command checks execute native programs directly. Use node.exe with the package manager JavaScript entry point, not .cmd/.bat." };
  const cwd = await realpath(workspace);
  const env: NodeJS.ProcessEnv = {};
  // No inherited API keys, proxy tokens, NODE_OPTIONS, package hooks, or user home config.
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.CI = "1";
  return new Promise((resolveResult) => {
    let output = Buffer.alloc(0); let reason: string | undefined; let settled = false;
    const child = spawn(spec.command, [...spec.args], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const finish = (status: "passed" | "failed" | "unknown", exitCode?: number, detail?: string) => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killWait); signal?.removeEventListener("abort", abort);
      resolveResult({ status, ...(exitCode !== undefined ? { exitCode } : {}), ...(detail ? { detail } : {}), output: boundedOutput(output, spec.maxOutputBytes ?? 65536) });
    };
    let killWait: ReturnType<typeof setTimeout> | undefined;
    const stop = (detail: string) => {
      if (reason) return; reason = detail; child.kill("SIGKILL");
      // A descendant may retain inherited pipes. No process-tree or OS isolation guarantee.
      killWait = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish("unknown", undefined, `${detail}; child effects require inspection`); }, 1000);
    };
    const abort = () => stop("Check interrupted");
    const timer = setTimeout(() => stop("Check timed out"), spec.timeoutMs ?? 30000);
    const collect = (chunk: Buffer) => {
      const limit = spec.maxOutputBytes ?? 65536;
      if (output.length + chunk.length > limit) { output = Buffer.concat([output, chunk.subarray(0, limit - output.length)]); stop("Check output limit exceeded"); }
      else output = Buffer.concat([output, chunk]);
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", (error) => finish(child.pid === undefined ? "failed" : "unknown", undefined, message(error)));
    child.on("close", (code, terminationSignal) => {
      if (reason || terminationSignal || code === null) finish("unknown", undefined, reason ?? `Check ended by ${terminationSignal ?? "unknown termination"}`);
      else finish(code === 0 ? "passed" : "failed", code, code === 0 ? "Configured command exited successfully" : "Configured command exited unsuccessfully");
    });
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
  });
}

async function readJournal(file: FileHandle): Promise<{ entries: Entry[]; committed: number; size: number }> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > maxJournalBytes) throw new Error("Invalid verification journal type or size");
  const bytes = Buffer.alloc(stat.size); let count = 0;
  while (count < bytes.length) { const result = await file.read(bytes, count, bytes.length - count, count); if (!result.bytesRead) break; count += result.bytesRead; }
  const committed = count === 0 || bytes[count - 1] === 10 ? count : bytes.subarray(0, count).lastIndexOf(10) + 1;
  const entries: Entry[] = [];
  const reportIds = new Set<string>(); const checkResults = new Map<string, TeamCheckResult>();
  let specs: readonly TeamCheckSpec[] = [];
  for (const line of bytes.subarray(0, committed).toString("utf8").split("\n").slice(0, -1)) {
    const entry = JSON.parse(line) as Entry;
    if (!entry || entry.sequence !== entries.length + 1 || !entry.event) throw new Error("Invalid verification journal sequence");
    const event = entry.event;
    if (event.type === "config") { if (entries.length !== 0) throw new Error("Duplicate verification config"); specs = parseTeamChecks(event.checks); }
    else if (entries.length === 0) throw new Error("Missing verification config");
    else if (event.type === "report") {
      parseTeamReport(event.report.report); validateStored(event.report);
      if (reportIds.size >= 256 || reportIds.has(event.report.commandId) || !Array.isArray(event.report.evidence)) throw new Error("Invalid stored report history");
      for (const item of event.report.evidence) {
        safeRelative(item.path); integer(item.startLine, 1, 1000000, "stored evidence startLine"); integer(item.endLine, item.startLine, 1000000, "stored evidence endLine");
        if (typeof item.valid !== "boolean" || (item.valid && !/^[a-f0-9]{64}$/u.test(item.sha256 ?? ""))) throw new Error("Invalid stored evidence");
      }
      reportIds.add(event.report.commandId);
    }
    else if (event.type === "check") {
      const result = event.result; parseTeamCheck(result.spec); validateStored(result);
      if (!isDeepStrictEqual(specs.find((entry) => entry.id === result.spec.id), result.spec) || result.taskId !== result.spec.taskId ||
        !["pending", "passed", "failed", "unknown", "cancelled"].includes(result.status) ||
        (result.afterFingerprint !== undefined && !/^[a-f0-9]{64}$/u.test(result.afterFingerprint))) throw new Error("Invalid check record");
      const old = checkResults.get(result.commandId);
      if (!old) { if (checkResults.size >= 512 || result.status !== "pending") throw new Error("Check result has no pending intent"); }
      else {
        if (!sameIdentity(old, result) || !isDeepStrictEqual(old.spec, result.spec) || old.workspaceFingerprint !== result.workspaceFingerprint ||
          (old.status !== "pending" && old.status !== "unknown") || result.status === "pending" ||
          (old.status === "unknown" && (!["failed", "cancelled"].includes(result.status) || !result.reconciliation))) throw new Error("Invalid check history transition");
      }
      checkResults.set(result.commandId, result);
    }
    else throw new Error("Unknown verification journal record");
    entries.push(entry);
  }
  return { entries, committed, size: stat.size };
}
function validateStored(value: StoredTeamReport | TeamCheckResult): void {
  identifier(value.commandId, "stored command id"); identifier(value.taskId, "stored task id");
  if (!/^[a-f0-9]{64}$/u.test(value.workspaceFingerprint)) throw new Error("Invalid stored workspace fingerprint");
}
function taskIdentity(execution: TaskExecution): Identity {
  return { taskId: execution.task.id, coordinationId: execution.coordinationId, dispatchId: execution.task.dispatchId, turn: execution.task.turn ?? 0 };
}
function sameIdentity(a: Identity, b: Identity): boolean { return a.taskId === b.taskId && a.coordinationId === b.coordinationId && a.dispatchId === b.dispatchId && a.turn === b.turn; }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("Invalid verification fields");
  return value as Record<string, unknown>;
}
function identifier(value: unknown, label: string): asserts value is string { if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u.test(value)) throw new Error(`Invalid ${label}`); }
function boundedString(value: unknown, label: string, max: number): asserts value is string { if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > max || value.includes("\0")) throw new Error(`Invalid ${label}`); }
function integer(value: unknown, min: number, max: number, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`Invalid ${label}`); }
function safeRelative(value: unknown): asserts value is string {
  boundedString(value, "workspace relative path", 2048);
  if (isAbsolute(value) || /[:\u0000-\u001f]/u.test(value) || value.replace(/\\/gu, "/").split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe workspace relative path");
}
async function rejectLinkIfPresent(path: string): Promise<void> { try { if ((await lstat(path)).isSymbolicLink()) throw new Error("Verification file must not be a symbolic link"); } catch (error) { if (!isMissing(error)) throw error; } }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function noFollow(): number { return process.platform === "win32" ? 0 : constants.O_NOFOLLOW; }
function hash(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function message(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 2048); }
function boundedOutput(bytes: Buffer, limit: number): string {
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text) <= limit) return text;
  // Replacement characters for invalid UTF-8 must not expand the persisted output past its cap.
  let count = 0; const characters: string[] = [];
  for (const character of text) { count += Buffer.byteLength(character); if (count > limit) break; characters.push(character); }
  return characters.join("");
}
