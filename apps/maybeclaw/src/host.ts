import { mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { ChannelHub, type SubmitTask } from "./channel-hub.js";
import { ChannelStore } from "./channel-store.js";
import type { ChannelAdapter } from "./channels.js";
import type { MaybeClaw } from "./service.js";
import { TaskLockedError } from "./store.js";
import type { TaskSpec } from "./types.js";

export interface HostOptions {
  claw: MaybeClaw;
  selectSpec: () => Promise<Omit<TaskSpec, "requestId" | "prompt">>;
  maxConcurrent?: number;
  adapters?: readonly ChannelAdapter[];
  /** Safe host-defined diagnostics, never raw SDK errors. */
  channelErrors?: Readonly<Record<string, string>>;
  startPaused?: boolean;
}

/** One local server owner, with separate execution and message-delivery loops. */
export class MaybeClawHost {
  readonly claw: MaybeClaw;
  readonly hub: ChannelHub;
  private readonly controller = new AbortController();
  private readonly active = new Map<string, Promise<void>>();
  private readonly dispatchErrors = new Map<string, string>();
  private channelRuns: Promise<void>[] = [];
  private ticking: Promise<void> | undefined;
  private delivering: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private error: string | undefined;
  private closed: Promise<void> | undefined;
  private admissions: Promise<void> = Promise.resolve();
  private constructor(private readonly options: HostOptions, private readonly lock: FileHandle, store: ChannelStore) {
    this.claw = options.claw;
    this.hub = new ChannelHub(store, options.adapters ?? [], this.claw, this.submit);
  }
  static async start(options: HostOptions): Promise<MaybeClawHost> {
    const count = options.maxConcurrent ?? 1;
    if (!Number.isSafeInteger(count) || count < 1 || count > 4) throw new Error("maxConcurrent must be 1..4");
    await mkdir(options.claw.store.directory, { recursive: true, mode: 0o700 });
    const path = join(options.claw.store.directory, "host.lock");
    let lock: FileHandle;
    try { lock = await open(path, "wx", 0o600); }
    catch { throw new Error("Host directory is locked or unavailable. Verify its owner has stopped before manually removing host.lock."); }
    let store: ChannelStore | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: Date.now() }) + "\n"); await lock.sync();
      store = await ChannelStore.open(join(options.claw.store.directory, "channels.jsonl"));
      const host = new MaybeClawHost(options, lock, store);
      if (!options.startPaused) host.startLoops();
      return host;
    } catch (error) { await store?.close(); await lock.close(); await unlink(path); throw error; }
  }
  readonly submit: SubmitTask = (prompt, requestId) => {
    const operation = this.admissions.then(async () => {
      if (this.controller.signal.aborted) throw new Error("Host is stopping");
      const tasks = await this.claw.store.list();
      const existing = tasks.find((task) => task.spec.requestId === requestId);
      if (existing) {
        if (existing.spec.prompt !== prompt) throw new Error("Request ID belongs to a different prompt");
        return { task: existing, created: false };
      }
      if (tasks.filter((v) => v.status === "queued").length >= 100) throw new Error("Task queue is full");
      return this.claw.submit({ ...(await this.options.selectSpec()), requestId, prompt });
    });
    this.admissions = operation.then(() => {}, () => {});
    return operation;
  };
  status() {
    return { state: this.controller.signal.aborted ? "stopping" : this.error || this.hub.processingErrors.size ? "degraded" : "running",
      active: this.active.size, maxConcurrent: this.options.maxConcurrent ?? 1,
      error: this.error ?? (this.hub.processingErrors.size ? "Some inbox events need attention. Check configuration/storage and restart." : null), dispatchErrors: Object.fromEntries(this.dispatchErrors),
      inboxErrors: Object.fromEntries(this.hub.processingErrors),
      channels: ["telegram", "feishu"].map((name) => {
        const adapter = this.hub.adapters.find((v) => v.name === name);
        return { name, state: this.options.channelErrors?.[name] ?? adapter?.status() ?? "disabled", allowedUsers: adapter?.allowUsers.length ?? 0 };
      }),
      deliveries: this.hub.store.values().filter((v) => v.kind === "delivery").map((v) => {
        if (v.kind !== "delivery") throw new Error("Invalid projection");
        return { id: v.id, channel: v.account.split(":")[0], taskId: v.taskId ?? null, status: v.status };
      }).slice(-100),
    };
  }
  retryDispatch(id: string): void { this.dispatchErrors.delete(id); }
  startLoops(): void {
    if (this.timer || this.controller.signal.aborted) return;
    for (const adapter of this.hub.adapters) {
      this.channelRuns.push(adapter.run((input) => this.hub.receive(input), this.hub.store, this.controller.signal)
        .catch(() => { this.error = "Channel receiver stopped; check credentials and platform settings, then restart."; }));
    }
    const schedule = () => {
      if (this.controller.signal.aborted) return;
      if (!this.ticking) this.ticking = this.tick().catch(() => { this.error = "Queue or inbox processing failed; inspect local state/configuration before restarting."; }).finally(() => { this.ticking = undefined; });
      if (!this.delivering) this.delivering = this.hub.deliver(this.controller.signal).catch(() => { this.error = "Delivery journal failed; no uncertain delivery will be retried."; }).finally(() => { this.delivering = undefined; });
    };
    this.timer = setInterval(schedule, 500);
    schedule();
  }
  private async tick(): Promise<void> {
    await this.hub.process();
    const tasks = [...await this.claw.store.list()].sort((a, b) => a.createdAt - b.createdAt);
    for (const task of tasks) {
      if (this.controller.signal.aborted || this.active.size >= (this.options.maxConcurrent ?? 1)) break;
      if (this.active.has(task.id) || this.dispatchErrors.has(task.id) || !["queued", "running"].includes(task.status)) continue;
      // A different foreground CLI process can still own a task. Never steal its lock.
      if (await this.claw.store.owner(task.id) !== null) continue;
      const execution = this.claw.run(task.id, this.controller.signal).then(() => {}, (error: unknown) => {
        if (!(error instanceof TaskLockedError)) this.dispatchErrors.set(task.id, "Dispatch failed. Check the pinned model/configuration and read scope; retry dispatch after fixing it.");
      }).finally(() => { this.active.delete(task.id); });
      this.active.set(task.id, execution);
    }
  }
  close(): Promise<void> {
    return this.closed ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort("Host stopping");
    await Promise.allSettled([...this.channelRuns, this.admissions, this.ticking, this.delivering]);
    await Promise.allSettled([...this.active.values()]);
    await this.hub.close();
    try { await this.hub.store.close(); }
    finally { await this.lock.close(); await unlink(join(this.claw.store.directory, "host.lock")); }
  }
}
