import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { AsyncStateSerializer, type AgentApplicationEvent } from "@may/application";
import { isStreamingMayEvent } from "@may/core";
import type { ApprovalDecision } from "@may/permissions";
import type { CoordinationAgent, TaskExecution, TaskRecovery } from "./types.js";
import { canonical, copy, freeze, name, positive, validateOutput } from "./validation.js";

interface Dispatch { readonly agent: string; readonly execution: TaskExecution }
interface Job extends Dispatch {
  readonly id: string;
  readonly fingerprint: string;
  readonly status: "queued" | "running" | "terminal";
  readonly cancelRequested?: boolean;
  readonly outcome?: TaskRecovery;
}
interface JobView { readonly id: string; readonly status: Job["status"]; readonly outcome?: TaskRecovery;
  readonly events: readonly { seq: number; event: AgentApplicationEvent }[]; readonly cursor: number }
interface Active { readonly controller: AbortController; readonly done: Promise<void>;
  readonly events: { seq: number; event: AgentApplicationEvent }[]; cursor: number }

export interface CoordinationWorkerOptions {
  readonly directory: string;
  /** Bearer secret, never persisted or added to task/model inputs. Use HTTPS off loopback. */
  readonly token: string;
  readonly agents: Readonly<Record<string, CoordinationAgent>>;
  /** Independent worker-side authority. Called before accepting or executing work. */
  authorize(dispatch: Readonly<Dispatch>): boolean | Promise<boolean>;
  readonly maxConcurrent?: number;
  readonly maxJobs?: number;
  readonly maxRequestBytes?: number;
  readonly maxJournalBytes?: number;
}

/** Authenticated worker endpoint. One durable writer; remote workers do not own the graph. */
export class CoordinationWorker {
  private readonly serial = new AsyncStateSerializer();
  private readonly jobs = new Map<string, Job>();
  private readonly active = new Map<string, Active>();
  private readonly ready = new Set<string>();
  private readonly views = new Map<string, Pick<Active, "events" | "cursor">>();
  private readonly agents: ReadonlyMap<string, CoordinationAgent>;
  private readonly authorize: CoordinationWorkerOptions["authorize"];
  private readonly secret: Buffer;
  private readonly maxConcurrent: number;
  private readonly maxJobs: number;
  private readonly maxRequestBytes: number;
  private readonly maxJournalBytes: number;
  private sequence = 0;
  private size = 0;
  private closing = false;
  private closed: Promise<void> | undefined;
  private fatal: unknown;

  private constructor(options: CoordinationWorkerOptions, private readonly file: FileHandle,
    private readonly lock: FileHandle, private readonly lockPath: string) {
    validateToken(options.token); this.secret = Buffer.from(options.token);
    this.maxConcurrent = options.maxConcurrent ?? 4; this.maxJobs = options.maxJobs ?? 1024;
    this.maxRequestBytes = options.maxRequestBytes ?? 1_048_576; this.maxJournalBytes = options.maxJournalBytes ?? 67_108_864;
    for (const value of [this.maxConcurrent, this.maxJobs, this.maxRequestBytes, this.maxJournalBytes]) positive(value, "worker limit");
    this.authorize = options.authorize.bind(options);
    this.agents = new Map(Object.entries(options.agents).map(([key, agent]) => {
      name(key, "worker agent"); name(agent.version, "worker agent version");
      return [key, Object.freeze({ version: agent.version, execute: agent.execute.bind(agent), recover: agent.recover.bind(agent),
        ...(agent.resolveApproval ? { resolveApproval: agent.resolveApproval.bind(agent) } : {}) })];
    }));
  }

  /** Opening reconciles durable outcomes only. It never starts a model/tool call. */
  static async open(options: CoordinationWorkerOptions): Promise<CoordinationWorker> {
    validateToken(options.token);
    const directory = resolve(options.directory); await mkdir(directory, { recursive: true });
    const lockPath = join(directory, "worker.lock"), path = join(directory, "worker.jsonl");
    const lock = await open(lockPath, "wx"); let file: FileHandle | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid })); await lock.sync();
      file = await open(path, "a+");
      const worker = new CoordinationWorker(options, file, lock, lockPath);
      if ((await file.stat()).size > worker.maxJournalBytes) throw new Error("Worker journal exceeds maxJournalBytes");
      const bytes = await readFile(path), end = bytes.length === 0 || bytes.at(-1) === 10 ? bytes.length : bytes.lastIndexOf(10) + 1;
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n").slice(0, -1)) {
        const record = JSON.parse(line) as { seq: number; job: Job };
        if (record.seq !== worker.sequence + 1) throw new Error("Invalid worker journal sequence");
        worker.validateJob(record.job); worker.sequence = record.seq; worker.jobs.set(record.job.id, freeze(copy(record.job)));
      }
      if (worker.jobs.size > worker.maxJobs) throw new Error("Worker journal exceeds maxJobs");
      if (end !== bytes.length) {
        const repair = await open(path, "r+"); try { await repair.truncate(end); await repair.sync(); } finally { await repair.close(); }
      }
      worker.size = end;
      for (const job of worker.jobs.values()) if (job.status !== "terminal") {
        await worker.recordRecovery(job, await worker.inspect(job));
      }
      return worker;
    } catch (error) { await file?.close(); await lock.close(); await unlink(lockPath); throw error; }
  }

  /** Pass to an HTTPS server, or an HTTP server bound to loopback. No CORS/browser API. */
  readonly handle = (request: IncomingMessage, response: ServerResponse): void => {
    void this.request(request, response).catch(() => reply(response, 400, { error: "Worker request rejected" }));
  };

  private async request(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const encrypted = "encrypted" in request.socket && request.socket.encrypted === true;
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
    const supplied = Buffer.from((request.headers.authorization ?? "").replace(/^Bearer /u, ""));
    if ((!encrypted && !local) || supplied.length !== this.secret.length || !timingSafeEqual(supplied, this.secret) || request.headers.origin) {
      reply(response, 401, { error: "Unauthorized worker request" }); return;
    }
    if (this.closing || this.fatal) { reply(response, 503, { error: "Worker unavailable; inspect durable recovery" }); return; }
    const url = new URL(request.url ?? "/", "http://worker.invalid");
    if (request.method === "POST" && ["/v1/jobs", "/v1/recover", "/v1/cancel"].includes(url.pathname)) {
      const dispatch = await body(request, this.maxRequestBytes) as Dispatch;
      const descriptor = this.describe(dispatch);
      // Revoking execution authority must not revoke the ability to stop that dispatch.
      if (url.pathname !== "/v1/cancel" && await this.authorize(freeze(copy(dispatch))) !== true) { reply(response, 403, { error: "Worker execution denied" }); return; }
      const view = await this.serial.run(async () => {
        this.assertOpen(); const current = this.jobs.get(descriptor.id);
        if (current && current.fingerprint !== descriptor.fingerprint) throw new Error("Dispatch identity conflict");
        if (url.pathname === "/v1/cancel") {
          if (!current) {
            if (this.jobs.size >= this.maxJobs) throw new Error("Worker maxJobs reached");
            // A durable tombstone also stops an acceptance request still in flight.
            await this.recordRecovery({ ...descriptor, cancelRequested: true }, await this.inspect(descriptor));
          } else await this.cancelJob(current);
          return { accepted: true };
        }
        if (url.pathname === "/v1/recover") {
          if (current?.status === "terminal" && current.outcome?.status !== "recovery-required") return current.outcome!;
          if (current && (this.active.has(current.id) || this.ready.has(current.id))) return { status: "recovery-required", detail: "Remote execution is active or accepted in the worker queue" } satisfies TaskRecovery;
          const outcome = await this.inspect(current ?? descriptor);
          if (current) await this.recordRecovery(current, outcome);
          return outcome;
        }
        if (!current) {
          if (this.jobs.size >= this.maxJobs) throw new Error("Worker maxJobs reached");
          // Existing Session evidence still wins if a dispatch ledger was lost separately.
          const outcome = await this.inspect(descriptor);
          await this.recordRecovery(descriptor, outcome);
        }
        if (this.jobs.get(descriptor.id)?.status === "queued") this.ready.add(descriptor.id);
        await this.pump(); return this.view(descriptor.id, 0);
      });
      reply(response, 200, view); return;
    }
    const match = /^\/v1\/jobs\/([a-f0-9]{64})(?:\/(cancel|approval))?$/u.exec(url.pathname);
    if (!match) { reply(response, 404, { error: "Unknown endpoint" }); return; }
    const id = match[1]!, job = this.jobs.get(id);
    if (!job) { reply(response, 404, { error: "Unknown dispatch" }); return; }
    if (request.method === "GET" && !match[2]) {
      const after = Number(url.searchParams.get("after") ?? "0");
      if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid event cursor");
      reply(response, 200, this.view(id, after)); return;
    }
    if (request.method === "POST" && match[2] === "cancel") {
      await this.serial.run(async () => {
        this.assertOpen(); const current = this.jobs.get(id)!;
        await this.cancelJob(current);
      });
      reply(response, 200, { accepted: true }); return;
    }
    if (request.method === "POST" && match[2] === "approval") {
      const input = await body(request, 4096) as { requestId: string; decision: ApprovalDecision };
      if (typeof input.requestId !== "string" || !["allow", "allow-session", "deny"].includes(input.decision)) throw new Error("Invalid approval");
      const active = this.active.get(id);
      const accepted = active && !active.controller.signal.aborted
        ? await this.agents.get(job.agent)!.resolveApproval?.(job.execution.task.sessionId, input.requestId, input.decision) ?? false : false;
      reply(response, 200, { accepted }); return;
    }
    reply(response, 405, { error: "Unsupported method" });
  }

  private describe(dispatch: Dispatch): Job {
    if (!dispatch || typeof dispatch !== "object") throw new Error("Invalid dispatch");
    name(dispatch.agent, "worker agent"); const execution = dispatch.execution, task = execution?.task;
    name(execution?.coordinationId, "coordination id");
    for (const key of ["id", "agent", "agentVersion", "sessionId", "dispatchId"] as const) name(task?.[key], key);
    if (typeof task.input !== "string" || !Number.isSafeInteger(task.turn ?? 0) || (task.turn ?? 0) < 0 || !Array.isArray(execution.dependencies)) throw new Error("Invalid execution");
    if (this.agents.get(dispatch.agent)?.version !== task.agentVersion) throw new Error("Remote agent version mismatch");
    const normalized = freeze(copy({ agent: dispatch.agent, execution }));
    return { ...normalized, id: dispatchId(execution), fingerprint: fingerprint(normalized), status: "queued" };
  }

  private validateJob(job: Job): void {
    const expected = this.describe(job);
    if (expected.id !== job.id || expected.fingerprint !== job.fingerprint || !["queued", "running", "terminal"].includes(job.status)) throw new Error("Invalid worker job record");
    if (job.status === "terminal") validateOutcome(job.outcome!);
  }

  private async inspect(job: Dispatch): Promise<TaskRecovery> {
    try { return validateOutcome(await this.agents.get(job.agent)!.recover(freeze(copy(job.execution)))); }
    catch { return { status: "recovery-required", detail: "Cannot establish durable remote outcome" }; }
  }

  private async cancelJob(job: Job): Promise<void> {
    if (job.status === "terminal" && job.outcome?.status !== "recovery-required") return;
    await this.save({ ...job, cancelRequested: true, ...(job.status === "queued" ? {
      status: "terminal" as const, outcome: { status: "cancelled" as const, detail: "Cancelled before remote execution" },
    } : {}) });
    this.ready.delete(job.id);
    this.active.get(job.id)?.controller.abort("Remote cancellation requested");
  }

  private recordRecovery(job: Job, outcome: TaskRecovery): Promise<void> {
    if (outcome.status === "not-started" && !job.cancelRequested) return this.save({ ...job, status: "queued" });
    const result = outcome.status === "not-started" ? { status: "cancelled" as const, detail: "Remote dispatch cancelled before input" } : outcome;
    return this.save({ ...job, status: "terminal", outcome: result });
  }

  private async pump(): Promise<void> {
    while (!this.closing && !this.fatal && this.active.size < this.maxConcurrent) {
      const job = [...this.jobs.values()].find((job) => job.status === "queued" && this.ready.has(job.id)); if (!job) return;
      let allowed = false; try { allowed = await this.authorize(freeze({ agent: job.agent, execution: job.execution })) === true; } catch { /* deny */ }
      if (!allowed) { await this.recordRecovery(job, { status: "failed", detail: "Worker dispatch denied" }); continue; }
      if (this.closing) return;
      const running = { ...job, status: "running" as const }; await this.save(running); this.ready.delete(job.id);
      const controller = new AbortController();
      const active: Active = { controller, events: [], cursor: 0, done: Promise.resolve().then(async () => {
        let outcome: TaskRecovery;
        try {
          const output = await this.agents.get(job.agent)!.execute(job.execution, { signal: controller.signal, report: (event) => {
            // Remote workers have no coordinator capability RPC; data/approvals only.
            if (event.type === "run.event" && isStreamingMayEvent(event.event)) return;
            if (active.events.length >= 1024) throw new Error("Remote event buffer exceeded");
            active.events.push({ seq: ++active.cursor, event: freeze(copy(event)) });
          } });
          outcome = "yielded" in output ? { status: "recovery-required", detail: "Remote workers cannot yield without coordinator capability RPC" }
            : { status: "completed", output: validateOutput(output, 1_048_576) };
        } catch {
          outcome = await this.inspect(job);
          if (outcome.status === "not-started") outcome = { status: controller.signal.aborted ? "cancelled" : "failed", detail: "Remote execution stopped before durable input" };
        }
        await this.serial.run(async () => {
          this.views.set(job.id, { events: active.events, cursor: active.cursor });
          try { if (!this.fatal) await this.recordRecovery(this.jobs.get(job.id)!, outcome); }
          finally { this.active.delete(job.id); }
          await this.pump();
        });
      }).catch((error) => { this.active.delete(job.id); this.fail(error); }) };
      this.active.set(job.id, active);
    }
  }

  private view(id: string, after: number): JobView {
    const job = this.jobs.get(id)!, buffer = this.active.get(id) ?? this.views.get(id);
    return { id, status: job.status, ...(job.outcome ? { outcome: job.outcome } : {}),
      events: buffer?.events.filter((event) => event.seq > after) ?? [], cursor: buffer?.cursor ?? 0 };
  }

  private async save(job: Job): Promise<void> {
    if (this.fatal) throw this.fatal;
    this.validateJob(job);
    const line = `${JSON.stringify({ seq: this.sequence + 1, job })}\n`, size = Buffer.byteLength(line);
    if (this.size + size > this.maxJournalBytes) { const error = new Error("Worker maxJournalBytes reached"); this.fail(error); throw error; }
    try { await this.file.writeFile(line); await this.file.sync(); }
    catch (error) { this.fail(error); throw error; }
    this.sequence++; this.size += size; this.jobs.set(job.id, freeze(copy(job)));
  }

  private assertOpen(): void { if (this.closing || this.fatal) throw new Error("Worker is unavailable"); }
  private fail(error: unknown): void { this.fatal ??= error; for (const active of this.active.values()) active.controller.abort("Worker persistence failure"); }

  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    return this.closed = (async () => {
      await this.serial.run(async () => {
        if (!this.fatal) for (const id of this.active.keys()) await this.save({ ...this.jobs.get(id)!, cancelRequested: true });
      }).catch((error) => this.fail(error));
      for (const active of this.active.values()) active.controller.abort("Worker closing");
      await Promise.all([...this.active.values()].map((active) => active.done));
      await this.serial.close(); await this.file.close(); await this.lock.close(); await unlink(this.lockPath);
    })();
  }
}

export interface RemoteAgentOptions {
  readonly url: string;
  readonly token: string;
  readonly agent: string;
  readonly version: string;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

/** Independent remote worker adapter. The coordinator keeps graph ownership and recovery policy. */
export function createRemoteAgent(options: RemoteAgentOptions): CoordinationAgent {
  options = { ...options }; validateToken(options.token); name(options.agent, "remote agent"); name(options.version, "remote version");
  const base = new URL(options.url);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/" || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) throw new Error("Remote worker requires an HTTPS origin except on loopback; credentials belong in token options");
  const timeout = options.requestTimeoutMs ?? 20_000, interval = options.pollIntervalMs ?? 250, maxBytes = options.maxResponseBytes ?? 2_097_152;
  for (const value of [timeout, interval, maxBytes]) positive(value, "remote limit");
  const active = new Map<string, string>();
  const request = async (path: string, value?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(new URL(path, base), { method: value === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }), signal: AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Remote worker rejected request (${response.status}); execution was not retried`); }
    if (!response.body) throw new Error("Missing remote response");
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    try { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
      if (size > maxBytes) throw new Error("Remote response exceeds limit"); chunks.push(chunk.value); }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  return {
    version: options.version,
    async execute(execution, context) {
      context.signal.throwIfAborted();
      const id = dispatchId(execution); let cursor = 0;
      active.set(execution.task.sessionId, id);
      try {
        let view = await request("/v1/jobs", { agent: options.agent, execution }, context.signal) as JobView;
        while (true) {
          if (view.id !== id || !Array.isArray(view.events) || !["queued", "running", "terminal"].includes(view.status)) throw new Error("Invalid remote job response");
          for (const item of view.events) if (item.seq > cursor) { context.report(item.event); cursor = item.seq; }
          if (view.status === "terminal") {
            const outcome = validateOutcome(view.outcome!);
            if (outcome.status === "completed") return outcome.output;
            throw new Error("Remote execution requires outcome reconciliation");
          }
          await pause(interval, context.signal);
          view = await request(`/v1/jobs/${id}?after=${cursor}`, undefined, context.signal) as JobView;
        }
      } catch (error) {
        if (context.signal.aborted) await request("/v1/cancel", { agent: options.agent, execution }).catch(() => undefined);
        throw error;
      } finally { active.delete(execution.task.sessionId); }
    },
    async recover(execution) {
      try {
        if (execution.task.cancelRequested) await request("/v1/cancel", { agent: options.agent, execution });
        return validateOutcome(await request("/v1/recover", { agent: options.agent, execution }) as TaskRecovery);
      }
      catch { return { status: "recovery-required", detail: "Remote outcome unavailable; do not re-dispatch or replay" }; }
    },
    async cancel(execution) { await request("/v1/cancel", { agent: options.agent, execution }); },
    async resolveApproval(sessionId, requestId, decision) {
      const id = active.get(sessionId); if (!id) return false;
      return (await request(`/v1/jobs/${id}/approval`, { requestId, decision }) as { accepted: boolean }).accepted === true;
    },
  };
}

function dispatchId(execution: TaskExecution): string {
  return createHash("sha256").update(canonical([execution.coordinationId, execution.task.id, execution.task.dispatchId, execution.task.turn ?? 0])).digest("hex");
}
function fingerprint(dispatch: Dispatch): string {
  const { status: _status, detail: _detail, cancelRequested: _cancel, output: _output, ...task } = dispatch.execution.task;
  return createHash("sha256").update(canonical({ agent: dispatch.agent, execution: { ...dispatch.execution, task } })).digest("hex");
}
function validateOutcome(outcome: TaskRecovery): TaskRecovery {
  if (!outcome || !["not-started", "completed", "failed", "cancelled", "recovery-required"].includes(outcome.status)) throw new Error("Invalid remote outcome");
  if (outcome.status === "completed") validateOutput(outcome.output, 1_048_576);
  else if (outcome.status !== "not-started" && (!("detail" in outcome) || typeof outcome.detail !== "string")) throw new Error("Invalid remote outcome detail");
  return freeze(copy(outcome));
}
function validateToken(token: string): void { if (typeof token !== "string" || token.length < 24 || /\s/u.test(token)) throw new Error("Worker token must contain at least 24 non-whitespace characters"); }
async function body(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maxBytes) throw new Error("Request too large"); chunks.push(bytes); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value));
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
