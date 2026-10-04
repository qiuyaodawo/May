import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { latestTime, nextTime } from "./triggers.js";
import {
  TaskRejectedError,
  type CreateJobInput,
  type ExecutionPage,
  type ExecutionQuery,
  type ExecutionRecord,
  type ScheduledJob,
  type SchedulerEvent,
  type SchedulerOptions,
  type SchedulerStore,
  type TaskDispatcher,
  type TickResult,
  type UpdateJobInput,
} from "./types.js";
import {
  cloneJson,
  validateEvent,
  validateExecutionQuery,
  validateId,
  validateJobInput,
  validateJobUpdate,
  validateRevision,
  validateTimestamp,
} from "./validation.js";

interface StoredEvent {
  event: SchedulerEvent;
  executionIds: string[];
}

interface DueBatch {
  ids: string[];
  created: number;
  skipped: number;
}

const MAX_TIMER_MS = 2_147_483_647;
const activeStores = new WeakSet<SchedulerStore>();

class SchedulerConflictError extends Error {}

export class Scheduler {
  private readonly store: SchedulerStore;
  private readonly dispatcher: TaskDispatcher;
  private readonly maxConcurrentSubmissions: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly operations = new Set<Promise<unknown>>();
  private readonly reserved = new Set<string>();
  private readonly reportedErrors = new Set<unknown>();
  private readonly slotWaiters: Array<() => void> = [];
  private submissionCount = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private backgroundBusy = false;
  private wakeRequested = false;
  private accepting = true;
  private manualTicks = 0;
  private closing = false;
  private closed = false;
  private fatalError: unknown;
  private hasFatalError = false;
  private stopOperation: Promise<void> | undefined;
  private closeOperation: Promise<void> | undefined;

  static open(options: SchedulerOptions): Scheduler {
    return new Scheduler(options);
  }

  private constructor(options: SchedulerOptions) {
    const concurrency = options.maxConcurrentSubmissions ?? 4;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new RangeError("maxConcurrentSubmissions must be a positive safe integer");
    }
    if (typeof options.dispatcher?.submit !== "function") {
      throw new TypeError("dispatcher.submit must be a function");
    }
    if (options.onError !== undefined && typeof options.onError !== "function") {
      throw new TypeError("onError must be a function");
    }
    this.store = options.store;
    if (activeStores.has(this.store)) throw new Error("Scheduler store is already in use");
    this.dispatcher = options.dispatcher;
    this.maxConcurrentSubmissions = concurrency;
    this.onError = options.onError;
    this.storage(() => this.store.transaction(() => {
      const schema = this.store.get<{ version: number }>("meta", "schema");
      if (schema !== undefined && schema.version !== 1) {
        throw new Error("Unsupported scheduler storage schema");
      }
      if (schema === undefined) {
        if (["jobs", "executions", "events"].some((collection) => this.store.list(collection).length > 0)) {
          throw new Error("Scheduler storage has records without schema metadata");
        }
        this.store.put("meta", "schema", { version: 1 });
        this.store.put("meta", "sequence", { value: 0 });
      }
      const sequence = this.store.get<{ value: number }>("meta", "sequence");
      if (sequence === undefined || !Number.isSafeInteger(sequence.value) || sequence.value < 0) {
        throw new Error("Invalid scheduler execution sequence");
      }
      for (const job of this.store.list<ScheduledJob>("jobs")) {
        this.validateStoredJob(job);
      }
      const seenSequences = new Set<number>();
      for (const record of this.store.list<ExecutionRecord>("executions")) {
        if (!Number.isSafeInteger(record.seq) || record.seq < 1 || record.seq > sequence.value || seenSequences.has(record.seq)) {
          throw new Error("Invalid stored execution sequence");
        }
        validateId(record.id);
        validateTimestamp(record.createdAt);
        validateTimestamp(record.updatedAt);
        this.validateStoredJob(record.job);
        if (!["pending", "dispatching", "submitted", "failed", "skipped"].includes(record.status)) {
          throw new Error("Invalid stored execution status");
        }
        if (record.status === "submitted") validateId(record.taskId);
        else if (record.taskId !== undefined) throw new Error("Unsubmitted execution has a task identifier");
        if (record.detail !== undefined && typeof record.detail !== "string") throw new Error("Invalid execution detail");
        if (record.event !== undefined) {
          validateEvent(record.event);
          if (record.scheduledAt !== undefined || record.job.trigger.type !== "event"
            || record.job.trigger.topic !== record.event.topic) throw new Error("Invalid execution event");
          const identity = executionIdentity(["event", record.event.source, record.event.id]);
          const event = this.store.get<StoredEvent>("events", identity);
          if (event === undefined || !event.executionIds.includes(record.id) || !isDeepStrictEqual(event.event, record.event)) {
            throw new Error("Execution event metadata is inconsistent");
          }
        } else {
          validateTimestamp(record.scheduledAt);
          if (record.job.trigger.type === "event") throw new Error("Event execution is missing event content");
        }
        seenSequences.add(record.seq);
      }
      for (const event of this.store.list<StoredEvent>("events")) {
        validateEvent(event.event);
        if (!Array.isArray(event.executionIds) || new Set(event.executionIds).size !== event.executionIds.length) {
          throw new Error("Invalid event execution references");
        }
        for (const id of event.executionIds) {
          validateId(id);
          const record = this.store.get<ExecutionRecord>("executions", id);
          if (record === undefined || !isDeepStrictEqual(record.event, event.event)) throw new Error("Event execution reference is inconsistent");
        }
      }
    }));
    activeStores.add(this.store);
  }

  async createJob(input: CreateJobInput): Promise<ScheduledJob> {
    this.assertUsable();
    validateJobInput(input);
    const copied = cloneJson(input);
    const job = await this.enqueue(() => this.storage(() => this.store.transaction(() => {
      if (this.store.get("meta", executionIdentity(["job", copied.id])) !== undefined) {
        throw new SchedulerConflictError(`Job identifier has already been used: ${copied.id}`);
      }
      const now = Date.now();
      const timestamp = new Date(now).toISOString();
      const nextAt = copied.enabled
        ? nextTime(copied.trigger, copied.trigger.type === "at" ? Number.NEGATIVE_INFINITY : now)
        : undefined;
      const result: ScheduledJob = {
        ...copied,
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        ...(nextAt === undefined ? {} : { nextAt }),
      };
      this.store.put("jobs", result.id, result);
      this.store.put("meta", executionIdentity(["job", result.id]), { createdAt: timestamp });
      return result;
    })));
    this.wake();
    return cloneJson(job);
  }

  async updateJob(id: string, input: UpdateJobInput, expectedRevision: number): Promise<ScheduledJob> {
    this.assertUsable();
    validateId(id);
    validateRevision(expectedRevision);
    validateJobUpdate(input);
    const copied = cloneJson(input);
    const job = await this.enqueue(() => this.storage(() => this.store.transaction(() => {
      const current = this.requireJob(id, expectedRevision);
      if (!Number.isSafeInteger(current.revision + 1)) throw new RangeError("Job revision exhausted");
      const now = Date.now();
      const { nextAt: previousNext, ...definition } = current;
      const merged = { ...definition, ...copied };
      const reset = copied.trigger !== undefined || (!current.enabled && merged.enabled);
      const after = copied.trigger?.type === "at" ? Number.NEGATIVE_INFINITY : now;
      const nextAt = !merged.enabled ? undefined : reset ? nextTime(merged.trigger, after) : previousNext;
      const result: ScheduledJob = {
        ...merged,
        revision: current.revision + 1,
        updatedAt: new Date(now).toISOString(),
        ...(nextAt === undefined ? {} : { nextAt }),
      };
      this.store.put("jobs", id, result);
      return result;
    })));
    this.wake();
    return cloneJson(job);
  }

  async deleteJob(id: string, expectedRevision: number): Promise<void> {
    this.assertUsable();
    validateId(id);
    validateRevision(expectedRevision);
    await this.enqueue(() => this.storage(() => this.store.transaction(() => {
      this.requireJob(id, expectedRevision);
      this.store.delete("jobs", id);
    })));
    this.wake();
  }

  async listJobs(): Promise<readonly ScheduledJob[]> {
    return this.enqueue(() => cloneJson(this.storage(() => this.store.list<ScheduledJob>("jobs")))
      .sort((left, right) => left.id.localeCompare(right.id)));
  }

  async publish(event: SchedulerEvent): Promise<readonly ExecutionRecord[]> {
    this.assertAccepting();
    validateEvent(event);
    const copied = cloneJson(event);
    return this.track(this.publishEvent(copied));
  }

  async listExecutions(query: ExecutionQuery = {}): Promise<ExecutionPage> {
    this.assertUsable();
    validateExecutionQuery(query);
    const copied = cloneJson(query);
    return this.enqueue(() => {
      const records = this.storage(() => this.store.list<ExecutionRecord>("executions"))
        .filter((record) => (copied.jobId === undefined || record.job.id === copied.jobId)
          && (copied.status === undefined || record.status === copied.status)
          && record.seq > (copied.afterSeq ?? 0))
        .sort((left, right) => left.seq - right.seq);
      const selected = records.slice(0, copied.limit ?? 100);
      const last = selected.at(-1);
      return cloneJson({
        records: selected,
        ...(records.length > selected.length && last !== undefined ? { nextAfterSeq: last.seq } : {}),
      });
    });
  }

  async tick(): Promise<TickResult> {
    this.assertUsable();
    if (this.running) throw new Error("tick() cannot run while start() is active");
    if (this.stopOperation !== undefined) throw new Error("Scheduler is stopping");
    this.accepting = true;
    this.manualTicks++;
    const operation = this.runTick().finally(() => { this.manualTicks--; });
    return this.track(operation);
  }

  async start(): Promise<void> {
    this.assertUsable();
    if (this.running) throw new Error("Scheduler is already started");
    if (this.manualTicks > 0 || this.stopOperation !== undefined) {
      throw new Error("Scheduler has an active tick or stop operation");
    }
    if (this.onError === undefined) throw new Error("start() requires an onError handler");
    this.running = true;
    this.accepting = true;
    if (this.backgroundBusy) {
      this.wakeRequested = true;
      return;
    }
    return this.track(this.runBackground(true));
  }

  stop(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.accepting = false;
    this.running = false;
    this.clearTimer();
    if (this.stopOperation !== undefined) return this.stopOperation;
    const operation = this.drain();
    this.stopOperation = operation;
    void operation.then(
      () => { this.stopOperation = undefined; },
      () => { this.stopOperation = undefined; },
    );
    return operation;
  }

  close(): Promise<void> {
    if (this.closeOperation !== undefined) return this.closeOperation;
    if (this.closed) return Promise.resolve();
    this.closing = true;
    this.accepting = false;
    this.running = false;
    this.clearTimer();
    this.closeOperation = this.drain().then(() => {
      this.storage(() => this.store.close());
      activeStores.delete(this.store);
      this.closed = true;
    });
    return this.closeOperation;
  }

  private async publishEvent(event: SchedulerEvent): Promise<readonly ExecutionRecord[]> {
    const ids = await this.enqueue(() => {
      this.assertAccepting();
      return this.storage(() => this.store.transaction(() => {
        const identity = executionIdentity(["event", event.source, event.id]);
        const existing = this.store.get<StoredEvent>("events", identity);
        if (existing !== undefined) {
          if (!isDeepStrictEqual(existing.event, event)) {
            throw new SchedulerConflictError("Event identity already exists with different content");
          }
          return existing.executionIds;
        }
        const timestamp = new Date().toISOString();
        const executionIds: string[] = [];
        for (const job of this.store.list<ScheduledJob>("jobs")) {
          if (!job.enabled || job.trigger.type !== "event" || job.trigger.topic !== event.topic) continue;
          const id = executionIdentity(["event", job.id, job.revision, event.source, event.id]);
          this.createExecution(job, id, timestamp, "pending", undefined, event);
          executionIds.push(id);
        }
        this.store.put("events", identity, { event, executionIds });
        return executionIds;
      }));
    });
    const candidates = await this.reserve(ids);
    const reportToBackground = this.running;
    try {
      await this.dispatchRecords(candidates);
    } catch (error) {
      if (reportToBackground) this.reportError(error);
      throw error;
    }
    const records = await this.enqueue(() => ids.map((id) => this.readExecution(id)), true);
    this.wake();
    return cloneJson(records);
  }

  private async runTick(): Promise<TickResult> {
    const batch = await this.enqueue(() => {
      if (!this.accepting) return { ids: [], created: 0, skipped: 0 };
      return this.storage(() => this.store.transaction(() => this.collectDue(Date.now())));
    }, true);
    const records = await this.dispatchRecords(batch.ids);
    return {
      created: batch.created,
      skipped: batch.skipped,
      submitted: records.filter((record) => record.status === "submitted").length,
      failed: records.filter((record) => record.status === "failed").length,
    };
  }

  private collectDue(now: number): DueBatch {
    const timestamp = new Date(now).toISOString();
    let created = 0;
    let skipped = 0;
    for (const job of this.store.list<ScheduledJob>("jobs")) {
      if (!job.enabled || job.nextAt === undefined || Date.parse(job.nextAt) > now) continue;
      const first = Date.parse(job.nextAt);
      const latest = latestTime(job.trigger, first - 1, now);
      if (latest === undefined) throw new Error(`Job has an invalid nextAt: ${job.id}`);
      const selected = job.misfire.policy === "latest" ? latest : job.nextAt;
      const expired = now - Date.parse(selected) > job.misfire.graceMs;
      if (job.misfire.policy === "latest" && latest !== job.nextAt) {
        const oldId = executionIdentity(["time", job.id, job.revision, job.nextAt]);
        if (this.createExecution(job, oldId, timestamp, "skipped", job.nextAt, undefined,
          `Earlier occurrences before ${latest} were skipped`)) {
          created++;
          skipped++;
        }
      }
      const id = executionIdentity(["time", job.id, job.revision, selected]);
      if (this.createExecution(job, id, timestamp, expired ? "skipped" : "pending", selected, undefined,
        expired ? `Occurrence outside grace period; considered through ${latest}` : undefined)) {
        created++;
        if (expired) skipped++;
      }
      const { nextAt: _previous, ...definition } = job;
      const nextAt = nextTime(job.trigger, now);
      this.store.put("jobs", job.id, {
        ...definition,
        ...(nextAt === undefined ? {} : { nextAt }),
      });
    }
    const ids = this.store.list<ExecutionRecord>("executions")
      .filter((record) => (record.status === "pending" || record.status === "dispatching") && !this.reserved.has(record.id))
      .sort((left, right) => left.seq - right.seq)
      .map((record) => record.id);
    for (const id of ids) this.reserved.add(id);
    return { ids, created, skipped };
  }

  private createExecution(
    job: ScheduledJob,
    id: string,
    timestamp: string,
    status: "pending" | "skipped",
    scheduledAt?: string,
    event?: SchedulerEvent,
    detail?: string,
  ): boolean {
    if (this.store.get("executions", id) !== undefined) return false;
    const sequence = this.store.get<{ value: number }>("meta", "sequence");
    if (sequence === undefined || !Number.isSafeInteger(sequence.value + 1)) {
      throw new RangeError("Scheduler execution sequence exhausted");
    }
    const record: ExecutionRecord = {
      id,
      seq: sequence.value + 1,
      job: cloneJson(job),
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(scheduledAt === undefined ? {} : { scheduledAt }),
      ...(event === undefined ? {} : { event: cloneJson(event) }),
      ...(detail === undefined ? {} : { detail }),
    };
    this.store.put("meta", "sequence", { value: record.seq });
    this.store.put("executions", id, record);
    return true;
  }

  private reserve(ids: readonly string[]): Promise<string[]> {
    return this.enqueue(() => {
      const candidates = ids.filter((id) => {
        const record = this.readExecution(id);
        return (record.status === "pending" || record.status === "dispatching") && !this.reserved.has(id);
      });
      for (const id of candidates) this.reserved.add(id);
      return candidates;
    }, true);
  }

  private async dispatchRecords(ids: readonly string[]): Promise<ExecutionRecord[]> {
    const outcomes = await Promise.allSettled(ids.map((id) => this.submitRecord(id)));
    const errors = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (errors.length === 1) throw errors[0]!.reason;
    if (errors.length > 1) throw new AggregateError(errors.map((error) => error.reason), "Scheduler submissions failed");
    return outcomes.map((outcome) => (outcome as PromiseFulfilledResult<ExecutionRecord>).value);
  }

  private async submitRecord(id: string): Promise<ExecutionRecord> {
    await this.acquireSlot();
    try {
      const claimed = await this.enqueue(() => {
        const record = this.readExecution(id);
        if (!this.accepting) return { record, submit: false };
        const updated: ExecutionRecord = { ...record, status: "dispatching", updatedAt: new Date().toISOString() };
        this.storage(() => this.store.put("executions", id, updated));
        return { record: updated, submit: true };
      }, true);
      if (!claimed.submit) return claimed.record;
      const record = claimed.record;
      let taskId: string;
      try {
        const result = await this.dispatcher.submit(cloneJson({
          executionId: id,
          handler: record.job.task.handler,
          payload: record.job.task.payload,
          ...(record.scheduledAt === undefined ? {} : { scheduledAt: record.scheduledAt }),
          ...(record.event === undefined ? {} : { event: record.event }),
        }));
        validateId(result.taskId);
        taskId = result.taskId;
      } catch (error) {
        if (!(error instanceof TaskRejectedError)) {
          this.running = false;
          this.accepting = false;
          this.clearTimer();
          throw error;
        }
        return this.enqueue(() => {
          const failed: ExecutionRecord = {
            ...record,
            status: "failed",
            updatedAt: new Date().toISOString(),
            detail: error.message,
          };
          this.storage(() => this.store.put("executions", id, failed));
          return failed;
        }, true);
      }
      return await this.enqueue(() => {
        const submitted: ExecutionRecord = { ...record, status: "submitted", taskId, updatedAt: new Date().toISOString() };
        this.storage(() => this.store.put("executions", id, submitted));
        return submitted;
      }, true);
    } finally {
      this.reserved.delete(id);
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.submissionCount < this.maxConcurrentSubmissions) {
      this.submissionCount++;
      return;
    }
    await new Promise<void>((resolve) => { this.slotWaiters.push(resolve); });
  }

  private releaseSlot(): void {
    const next = this.slotWaiters.shift();
    if (next !== undefined) next();
    else this.submissionCount--;
  }

  private async runBackground(propagate: boolean): Promise<void> {
    if (this.backgroundBusy || !this.running) return;
    this.backgroundBusy = true;
    try {
      await this.runTick();
      await this.enqueue(() => this.scheduleNext(), true);
    } catch (error) {
      this.running = false;
      this.accepting = false;
      this.clearTimer();
      this.reportError(error);
      if (propagate) throw error;
    } finally {
      this.backgroundBusy = false;
      if (this.wakeRequested) {
        this.wakeRequested = false;
        this.wake();
      }
    }
  }

  private wake(): void {
    if (!this.running || this.closed || this.closing) return;
    if (this.backgroundBusy) {
      this.wakeRequested = true;
      return;
    }
    this.clearTimer();
    this.timer = setTimeout(() => this.fireBackground(), 0);
  }

  private scheduleNext(): void {
    this.clearTimer();
    if (!this.running || !this.accepting || this.closing || this.closed) return;
    const next = this.storage(() => {
      if (this.store.list<ExecutionRecord>("executions").some((record) =>
        (record.status === "pending" || record.status === "dispatching") && !this.reserved.has(record.id))) return Date.now();
      const times = this.store.list<ScheduledJob>("jobs")
        .filter((job) => job.enabled && job.nextAt !== undefined)
        .map((job) => Date.parse(job.nextAt!));
      return times.length === 0 ? undefined : Math.min(...times);
    });
    if (next === undefined) return;
    this.timer = setTimeout(() => this.fireBackground(), Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now())));
  }

  private fireBackground(): void {
    this.timer = undefined;
    void this.track(this.runBackground(false)).catch((error) => {
      queueMicrotask(() => { throw error; });
    });
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private requireJob(id: string, expectedRevision: number): ScheduledJob {
    const job = this.store.get<ScheduledJob>("jobs", id);
    if (job === undefined) throw new SchedulerConflictError(`Job does not exist: ${id}`);
    if (job.revision !== expectedRevision) throw new SchedulerConflictError(`Job revision conflict: ${id}`);
    return job;
  }

  private validateStoredJob(job: ScheduledJob): void {
    validateJobInput({ id: job.id, enabled: job.enabled, trigger: job.trigger, task: job.task, misfire: job.misfire });
    validateRevision(job.revision);
    validateTimestamp(job.createdAt);
    validateTimestamp(job.updatedAt);
    if (job.nextAt !== undefined) {
      validateTimestamp(job.nextAt);
      if (!job.enabled || job.trigger.type === "event") throw new Error("Invalid stored job nextAt");
    } else if (job.enabled && job.trigger.type === "cron") {
      throw new Error("Enabled cron job is missing nextAt");
    }
    if (this.store.get("meta", executionIdentity(["job", job.id])) === undefined) throw new Error("Stored job lacks identity metadata");
  }

  private reportError(error: unknown): void {
    if (this.reportedErrors.has(error)) return;
    this.reportedErrors.add(error);
    this.onError!(error);
  }

  private readExecution(id: string): ExecutionRecord {
    const record = this.storage(() => this.store.get<ExecutionRecord>("executions", id));
    if (record === undefined) throw new Error(`Execution does not exist: ${id}`);
    return record;
  }

  private enqueue<T>(operation: () => T, internal = false): Promise<T> {
    if (!internal) this.assertUsable();
    const result = this.mutationQueue.then(() => {
      if (!internal) this.assertUsable();
      else if (this.hasFatalError) throw this.fatalError;
      return operation();
    });
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private storage<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof SchedulerConflictError) throw error;
      this.fatalError = error;
      this.hasFatalError = true;
      this.accepting = false;
      this.running = false;
      this.clearTimer();
      throw error;
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => { this.operations.delete(operation); },
      () => { this.operations.delete(operation); },
    );
    return operation;
  }

  private async drain(): Promise<void> {
    await this.mutationQueue;
    await Promise.allSettled([...this.operations]);
    await this.mutationQueue;
  }

  private assertUsable(): void {
    if (this.closed || this.closing) throw new Error("Scheduler is closed");
    if (this.hasFatalError) throw this.fatalError;
  }

  private assertAccepting(): void {
    this.assertUsable();
    if (!this.accepting) throw new Error("Scheduler is stopped; call start() or tick() to resume");
  }
}

function executionIdentity(parts: readonly (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
