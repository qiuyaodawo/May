import { createHash, randomUUID } from "node:crypto";
import type { McpCredentialStore } from "./credentials.js";
import type { McpInteractionOwner } from "./interactions.js";
import { freezeTree, integer, object, parseMcpTask, taskFailure, text, type McpRemoteTask, type McpTaskStatus } from "./tasks.js";

export interface McpTaskBinding {
  readonly serverId: string;
  readonly protocolVersion: "2026-07-28";
  /** Opaque digest of endpoint configuration and current authorization grant identity. */
  readonly endpointIdentity: string;
  readonly toolName: string;
  /** The complete original tool definition, not merely its name. */
  readonly toolDefinitionHash: string;
}

export interface McpTaskInputClaim {
  readonly id: string;
  readonly fingerprint: string;
  readonly state: "claimed" | "submitted" | "acknowledged" | "abandoned";
  readonly samplingReserved?: true;
  readonly samplingReservations?: number;
  readonly expiresAt?: number;
}

export interface McpTaskRecord {
  readonly version: 1;
  /** Host-generated handle. The remote id is never a filename or ownership proof. */
  readonly id: string;
  readonly owner: McpInteractionOwner;
  readonly binding: McpTaskBinding;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: "starting" | "uncertain" | McpTaskStatus;
  /** Metadata only: no task result, error, input request or status message is retained. */
  readonly remote?: Omit<McpRemoteTask, "statusMessage">;
  readonly cancellation?: "requested" | "acknowledged";
  /** Hashed remote input keys; no prompts/answers or provider output. */
  readonly inputs: Readonly<Record<string, McpTaskInputClaim>>;
  readonly samplingCalls: number;
  readonly samplingTokens: number;
  readonly initialUsage?: { readonly inputs: number; readonly samplingCalls: number; readonly samplingTokens: number };
  readonly inputAttempts?: number;
}

type SessionOwner = Pick<McpInteractionOwner, "workspaceId" | "sessionId">;
type Mutable<T> = { -readonly [P in keyof T]: T[P] };
interface Journal { version: 1; records: McpTaskRecord[] }

/**
 * Write-ahead, owner-partitioned persistence for the task lifecycle. Supply a
 * secure transactional store, normally a separate KeyringMcpCredentialStore.
 * It never performs RPCs, replays operations, polls, approves or invokes models.
 */
export class McpTaskJournal {
  constructor(private readonly store: McpCredentialStore) {}

  /** Persist BEFORE issuing a task-capable call. Failure must prevent the send. */
  begin(owner: McpInteractionOwner, binding: McpTaskBinding, signal?: AbortSignal): Promise<McpTaskRecord> {
    validOwner(owner); validBinding(binding);
    return this.transact(owner, (journal) => {
      if (journal.records.length >= 64) throw taskFailure(binding.serverId, "task journal is full; explicitly forget finished handles");
      const now = Date.now();
      const record: McpTaskRecord = { version: 1, id: randomUUID(), owner: structuredClone(owner), binding: structuredClone(binding),
        createdAt: now, updatedAt: now, status: "starting", inputs: {}, samplingCalls: 0, samplingTokens: 0 };
      journal.records.push(record); return record;
    }, signal);
  }

  /** Local recovery inventory only, never tasks/list against a remote server. */
  async list(owner: SessionOwner): Promise<readonly McpTaskRecord[]> {
    return freezeTree((await this.load(owner)).records);
  }

  async get(id: string, owner: SessionOwner, binding: McpTaskBinding): Promise<McpTaskRecord> {
    return freezeTree(this.find(await this.load(owner), id, binding));
  }

  /** Record a durably created remote handle, or a subsequently observed state. */
  observe(id: string, owner: SessionOwner, binding: McpTaskBinding, raw: unknown, kind: "created" | "state", signal?: AbortSignal): Promise<McpTaskRecord> {
    const state = kind === "created" ? parseMcpTask(raw, "created", binding.serverId) : parseMcpTask(raw, "state", binding.serverId);
    return this.change(id, owner, binding, async (record, journal) => {
      if (kind === "created" && record.remote !== undefined) throw taskFailure(binding.serverId, "task handle was already bound");
      if (kind === "state" && record.remote === undefined) throw taskFailure(binding.serverId, "cannot poll an unbound task handle");
      if (record.remote !== undefined) {
        if (record.remote.taskId !== state.taskId || record.remote.createdAt !== state.createdAt) throw taskFailure(binding.serverId, "task identity changed");
        if (Date.parse(record.remote.lastUpdatedAt) > Date.parse(state.lastUpdatedAt)) throw taskFailure(binding.serverId, "task state moved backwards");
        if (terminal(record.status) && record.status !== state.status) throw taskFailure(binding.serverId, "terminal task status changed");
      }
      if (journal.records.some((other) => other.id !== id && other.binding.endpointIdentity === binding.endpointIdentity && other.binding.serverId === binding.serverId && other.remote?.taskId === state.taskId)) throw taskFailure(binding.serverId, "remote task id already belongs to another local operation");
      await this.bindRemote(record, state.taskId, signal);
      const { taskId, status, createdAt, lastUpdatedAt, ttlMs, pollIntervalMs } = state;
      record.remote = { taskId, status, createdAt, lastUpdatedAt, ttlMs, ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }) };
      record.status = status;
    }, signal);
  }

  /** Unknown call outcome stays recoverable and is NEVER an instruction to resend. */
  uncertain(id: string, owner: SessionOwner, binding: McpTaskBinding): Promise<McpTaskRecord> {
    return this.change(id, owner, binding, (record) => {
      if (record.remote === undefined) record.status = "uncertain";
    });
  }

  /** Carry synchronous pre-creation MRTR usage into the durable task's budgets. */
  initialUsage(id: string, owner: SessionOwner, binding: McpTaskBinding, usage: NonNullable<McpTaskRecord["initialUsage"]>): Promise<McpTaskRecord> {
    if (!integer(usage.inputs, 0) || usage.inputs > 32 || !integer(usage.samplingCalls, 0) || usage.samplingCalls > 4 || !integer(usage.samplingTokens, 0) || usage.samplingTokens > usage.samplingCalls * 4096) throw taskFailure(binding.serverId, "invalid initial task usage");
    return this.change(id, owner, binding, (record) => {
      if (record.remote !== undefined || record.initialUsage !== undefined) throw taskFailure(binding.serverId, "initial task usage already recorded");
      record.initialUsage = { ...usage }; record.samplingCalls = usage.samplingCalls; record.samplingTokens = usage.samplingTokens;
    });
  }

  /** Reserve a unique input key before any UI/model work. Repeated polls do not reclaim it. */
  claimInput(id: string, owner: SessionOwner, binding: McpTaskBinding, key: string, input: unknown, signal?: AbortSignal, options: { expiresAt?: number; retryClaimId?: string } = {}): Promise<{ readonly record: McpTaskRecord; readonly claim?: McpTaskInputClaim }> {
    if (!text(key, 1024) || !object(input) || Buffer.byteLength(JSON.stringify(input)) > 64 * 1024) throw taskFailure(binding.serverId, "invalid task input");
    const inputKey = digest(key); const fingerprint = digest(stable(input));
    const expiresAt = options.expiresAt ?? Date.now() + 60_000;
    if (!integer(expiresAt, Date.now()) || expiresAt > Date.now() + 86_400_000) throw taskFailure(binding.serverId, "invalid task input deadline");
    return this.transact(owner, (journal) => {
      const current = this.find(journal, id, binding); requireInput(current);
      const previous = current.inputs[inputKey];
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) throw taskFailure(binding.serverId, "server reused a task input key for different content");
        if (options.retryClaimId === undefined) return { record: current };
        if (options.retryClaimId !== previous.id || previous.state === "acknowledged" || previous.state !== "abandoned" && (previous.expiresAt === undefined || previous.expiresAt > Date.now())) throw taskFailure(binding.serverId, "task input is still active or already acknowledged; cannot retry it");
      }
      const attempts = current.inputAttempts ?? Object.keys(current.inputs).length;
      if (attempts + (current.initialUsage?.inputs ?? 0) >= 32) throw taskFailure(binding.serverId, "task host-input budget exceeded");
      const claim: McpTaskInputClaim = { id: randomUUID(), fingerprint, state: "claimed", expiresAt,
        samplingReservations: previous?.samplingReservations ?? (previous?.samplingReserved ? 1 : 0) };
      const record: McpTaskRecord = { ...current, inputAttempts: attempts + 1, updatedAt: Math.max(Date.now(), current.updatedAt), inputs: { ...current.inputs, [inputKey]: claim } };
      journal.records[journal.records.indexOf(current)] = record;
      return { record, claim };
    }, signal);
  }

  /** Reserve approved provider tokens durably BEFORE calling the provider. */
  reserveSampling(id: string, owner: SessionOwner, binding: McpTaskBinding, claimId: string, maxTokens: number, signal?: AbortSignal): Promise<McpTaskRecord> {
    if (!integer(maxTokens, 1) || maxTokens > 4096) throw taskFailure(binding.serverId, "invalid task sampling budget");
    return this.change(id, owner, binding, (record) => {
      requireInput(record);
      const entry = Object.entries(record.inputs).find(([, claim]) => claim.id === claimId && claim.state === "claimed" && !claim.samplingReserved);
      if (entry === undefined) throw taskFailure(binding.serverId, "missing unreserved task input claim");
      if (record.samplingCalls >= 4 || record.samplingTokens + maxTokens > 16_384) throw taskFailure(binding.serverId, "task sampling budget exceeded");
      record.samplingCalls++; record.samplingTokens += maxTokens;
      record.inputs = { ...record.inputs, [entry[0]]: { ...entry[1], samplingReserved: true, samplingReservations: (entry[1].samplingReservations ?? 0) + 1 } };
    }, signal);
  }

  /** End a local attempt, preserving spent budgets and all acknowledged answers. */
  abandonInput(id: string, owner: SessionOwner, binding: McpTaskBinding, claimId: string): Promise<McpTaskRecord> {
    return this.change(id, owner, binding, (record) => {
      const entry = Object.entries(record.inputs).find(([, claim]) => claim.id === claimId);
      if (entry === undefined || entry[1].state === "acknowledged") return;
      record.inputs = { ...record.inputs, [entry[0]]: { ...entry[1], state: "abandoned" } };
    });
  }

  /** Persist submitted BEFORE tasks/update; acknowledgement does not mean the task completed. */
  markInput(id: string, owner: SessionOwner, binding: McpTaskBinding, claimId: string, state: "submitted" | "acknowledged", signal?: AbortSignal): Promise<McpTaskRecord> {
    return this.change(id, owner, binding, (record) => {
      requireInput(record);
      const entry = Object.entries(record.inputs).find(([, claim]) => claim.id === claimId);
      if (entry === undefined || entry[1].state !== (state === "submitted" ? "claimed" : "submitted")) throw taskFailure(binding.serverId, "invalid task input transition");
      record.inputs = { ...record.inputs, [entry[0]]: { ...entry[1], state } };
    }, signal);
  }

  /** Remote cancel is an intent, NOT a local terminal status. Local waiting needs no journal write. */
  cancelIntent(id: string, owner: SessionOwner, binding: McpTaskBinding, state: "requested" | "acknowledged", signal?: AbortSignal): Promise<McpTaskRecord> {
    return this.change(id, owner, binding, (record) => {
      if (record.remote === undefined) throw taskFailure(binding.serverId, "cannot cancel without a remote handle");
      if (state === "acknowledged" && record.cancellation !== "requested") throw taskFailure(binding.serverId, "no recorded cancellation intent");
      if (state === "requested" && record.cancellation !== undefined) throw taskFailure(binding.serverId, "cancellation already requested; poll instead of replaying it");
      record.cancellation = state;
    }, signal);
  }

  /** Explicit local deletion only. Does not cancel remote work or erase remote data. */
  forget(id: string, owner: SessionOwner, binding: McpTaskBinding, signal?: AbortSignal): Promise<void> {
    return this.transact(owner, (journal) => { const record = this.find(journal, id, binding); journal.records.splice(journal.records.indexOf(record), 1); }, signal);
  }

  private change(id: string, owner: SessionOwner, binding: McpTaskBinding, work: (record: Mutable<McpTaskRecord>, journal: Journal) => void | Promise<void>, signal?: AbortSignal): Promise<McpTaskRecord> {
    return this.transact(owner, async (journal) => {
      const current = this.find(journal, id, binding); const record = { ...current, updatedAt: Math.max(Date.now(), current.updatedAt) };
      await work(record, journal); journal.records[journal.records.indexOf(current)] = record; return record;
    }, signal);
  }

  private async transact<T>(owner: SessionOwner, work: (journal: Journal) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    const key = partition(owner);
    return this.store.exclusive(key, async () => {
      signal?.throwIfAborted();
      const journal = await this.load(owner);
      const result = await work(journal);
      signal?.throwIfAborted();
      if (Buffer.byteLength(JSON.stringify(journal)) > 512 * 1024) throw taskFailure("journal", "task journal exceeds storage limit");
      await this.store.set(key, journal);
      return freezeTree(structuredClone(result));
    }, signal);
  }

  private async bindRemote(record: McpTaskRecord, taskId: string, signal?: AbortSignal): Promise<void> {
    // Cross-Session uniqueness. Reserve before writing the Session record so a
    // crash can leave only a restrictive tombstone, never an unowned remote id.
    // Forgetting local history does not let a server rebind its old id elsewhere.
    const key = `mcp-task-owners.v1:${digest(record.binding.endpointIdentity)}`;
    await this.store.exclusive(key, async () => {
      const value = await this.store.get<unknown>(key) ?? { version: 1, owners: {} };
      if (!object(value) || value.version !== 1 || !object(value.owners) || Object.keys(value.owners).length > 1024 ||
          Object.entries(value.owners).some(([id, claim]) => !hash(id) || !hash(claim))) throw taskFailure(record.binding.serverId, "invalid task ownership index");
      const remote = digest(taskId); const owner = digest(JSON.stringify([record.owner.workspaceId, record.owner.sessionId, record.id]));
      if (value.owners[remote] !== undefined) {
        if (value.owners[remote] !== owner) throw taskFailure(record.binding.serverId, "remote task id already belongs to another Session or operation");
        return;
      }
      if (Object.keys(value.owners).length >= 1024) throw taskFailure(record.binding.serverId, "task ownership index is full; explicit store maintenance required");
      signal?.throwIfAborted();
      await this.store.set(key, { version: 1, owners: { ...value.owners, [remote]: owner } });
    }, signal);
  }

  private async load(owner: SessionOwner): Promise<Journal> {
    const value = await this.store.get<unknown>(partition(owner));
    if (value === undefined) return { version: 1, records: [] };
    try {
      if (!object(value) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 64 || Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new Error();
      const ids = new Set<string>();
      for (const record of value.records) {
        validateRecord(record, owner);
        if (ids.has(record.id)) throw new Error(); ids.add(record.id);
      }
      return structuredClone(value) as unknown as Journal;
    } catch { throw taskFailure("journal", "invalid task journal; no remote request is authorized"); }
  }

  private find(journal: Journal, id: string, binding: McpTaskBinding): McpTaskRecord {
    validBinding(binding);
    const record = journal.records.find((entry) => entry.id === id);
    if (record === undefined || stable(record.binding) !== stable(binding)) throw taskFailure(binding.serverId, "task not owned by this Session, endpoint identity or tool definition");
    return record;
  }
}

function validateRecord(value: unknown, owner: SessionOwner): asserts value is McpTaskRecord {
  if (!object(value) || value.version !== 1 || !uuid(value.id) || !object(value.owner) || !object(value.binding)) throw new Error();
  if (Object.keys(value).some((key) => !["version", "id", "owner", "binding", "createdAt", "updatedAt", "status", "remote", "cancellation", "inputs", "samplingCalls", "samplingTokens", "initialUsage", "inputAttempts"].includes(key))) throw new Error();
  validOwner(value.owner as unknown as McpInteractionOwner); validBinding(value.binding as unknown as McpTaskBinding);
  if (value.owner.workspaceId !== owner.workspaceId || value.owner.sessionId !== owner.sessionId || !integer(value.createdAt, 0) || !integer(value.updatedAt, value.createdAt)) throw new Error();
  if (!["starting", "uncertain", "working", "input_required", "completed", "cancelled", "failed"].includes(value.status as string)) throw new Error();
  if (value.remote !== undefined) {
    if (!object(value.remote) || "statusMessage" in value.remote || Object.keys(value.remote).some((key) => !["taskId", "status", "createdAt", "lastUpdatedAt", "ttlMs", "pollIntervalMs"].includes(key))) throw new Error();
    const remote = parseMcpTask({ ...value.remote, resultType: "task" }, "created", value.binding.serverId as string);
    if (remote.status !== value.status) throw new Error();
  } else if (!["starting", "uncertain"].includes(value.status as string)) throw new Error();
  if (value.cancellation !== undefined && (!["requested", "acknowledged"].includes(value.cancellation as string) || value.remote === undefined)) throw new Error();
  if (!integer(value.samplingCalls, 0) || value.samplingCalls > 4 || !integer(value.samplingTokens, 0) || value.samplingTokens > 16_384 || !object(value.inputs) || Object.keys(value.inputs).length > 32) throw new Error();
  const claims = new Set<string>();
  for (const [key, claim] of Object.entries(value.inputs)) {
    if (!hash(key) || !object(claim) || !uuid(claim.id) || claims.has(claim.id) || !hash(claim.fingerprint) || !["claimed", "submitted", "acknowledged", "abandoned"].includes(claim.state as string) || claim.samplingReserved !== undefined && claim.samplingReserved !== true ||
        claim.expiresAt !== undefined && !integer(claim.expiresAt, 0) || claim.samplingReservations !== undefined && (!integer(claim.samplingReservations, claim.samplingReserved ? 1 : 0) || claim.samplingReservations > 4) ||
        Object.keys(claim).some((key) => !["id", "fingerprint", "state", "samplingReserved", "samplingReservations", "expiresAt"].includes(key))) throw new Error();
    claims.add(claim.id);
  }
  const initial = value.initialUsage;
  if (initial !== undefined && (!object(initial) || !integer(initial.inputs, 0) || initial.inputs + Object.keys(value.inputs).length > 32 || !integer(initial.samplingCalls, 0) || initial.samplingCalls > 4 || !integer(initial.samplingTokens, 0) || initial.samplingTokens > initial.samplingCalls * 4096)) throw new Error();
  if (value.inputAttempts !== undefined && (!integer(value.inputAttempts, Object.keys(value.inputs).length) || value.inputAttempts + ((initial as { inputs: number } | undefined)?.inputs ?? 0) > 32)) throw new Error();
  if (Object.values(value.inputs).reduce<number>((total, raw) => { const claim = raw as Record<string, unknown>; return total + (claim.samplingReservations as number | undefined ?? (claim.samplingReserved ? 1 : 0)); }, 0) + ((initial as { samplingCalls: number } | undefined)?.samplingCalls ?? 0) !== value.samplingCalls ||
      value.samplingTokens < ((initial as { samplingTokens: number } | undefined)?.samplingTokens ?? 0) + value.samplingCalls - ((initial as { samplingCalls: number } | undefined)?.samplingCalls ?? 0) || value.samplingTokens > value.samplingCalls * 4096) throw new Error();
}
function validOwner(owner: SessionOwner): void {
  if (!object(owner) || !text(owner.workspaceId, 4096) || !text(owner.sessionId, 1024) || Object.keys(owner).some((key) => !["workspaceId", "sessionId", "runId", "toolCallId"].includes(key)) ||
      Object.entries(owner).some(([, value]) => !text(value, 4096))) throw taskFailure("journal", "invalid trusted task owner");
}
function validBinding(binding: McpTaskBinding): void {
  if (!object(binding) || binding.protocolVersion !== "2026-07-28" || !text(binding.serverId, 128) || !text(binding.toolName, 1024) || !hash(binding.endpointIdentity) || !hash(binding.toolDefinitionHash) ||
      Object.keys(binding).some((key) => !["serverId", "protocolVersion", "toolName", "endpointIdentity", "toolDefinitionHash"].includes(key))) throw taskFailure("journal", "invalid trusted task binding");
}
function requireInput(record: McpTaskRecord): void {
  if (record.status !== "input_required" || record.cancellation !== undefined) throw taskFailure(record.binding.serverId, "task is not accepting host input");
}
function terminal(status: McpTaskRecord["status"]): boolean { return ["completed", "failed", "cancelled"].includes(status); }
function partition(owner: SessionOwner): string { validOwner(owner); return `mcp-tasks.v1:${digest(JSON.stringify([owner.workspaceId, owner.sessionId]))}`; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function uuid(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value); }
function stable(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry) ? entry.map(canonical) : object(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : entry;
  return JSON.stringify(canonical(value));
}
