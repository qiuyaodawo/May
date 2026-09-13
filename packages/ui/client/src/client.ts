import { UiError, type UiCommand, type UiReceipt, type UiSnapshot } from "./protocol.js";

export interface UiClientState {
  readonly snapshot: UiSnapshot | null;
  readonly connection: "disconnected" | "connecting" | "connected" | "reconnecting";
  readonly busy: boolean;
  readonly error: string | null;
}

/** Browser-safe client. Credentials are memory-only; commands are never auto-retried. */
export class UiClient {
  private token = "";
  private selectedId: string | undefined;
  private lifetime: AbortController | undefined;
  private generation = 0;
  private refreshId = 0;
  private listeners = new Set<(state: UiClientState) => void>();
  private value: UiClientState = { snapshot: null, connection: "disconnected", busy: false, error: null };
  constructor(private readonly baseUrl = "", private readonly request: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  get state(): UiClientState { return this.value; }
  subscribe(listener: (state: UiClientState) => void): () => void {
    this.listeners.add(listener); listener(this.value); return () => this.listeners.delete(listener);
  }
  private update(change: Partial<UiClientState>): void {
    this.value = { ...this.value, ...change };
    for (const listener of this.listeners) listener(this.value);
  }
  async connect(token: string): Promise<void> {
    this.disconnect(); this.token = token; this.lifetime = new AbortController();
    const generation = this.generation;
    this.update({ connection: "connecting", error: null });
    try { await this.refresh(); }
    catch (error) { if (generation === this.generation) { this.disconnect(); this.update({ error: describe(error) }); } throw error; }
    if (generation === this.generation) void this.watch(this.lifetime!.signal, generation);
  }
  disconnect(): void {
    this.generation++; this.lifetime?.abort(); this.lifetime = undefined; this.token = "";
    this.selectedId = undefined;
    this.update({ snapshot: null, connection: "disconnected", busy: false, error: null });
  }
  async select(id?: string): Promise<void> { this.selectedId = id; await this.refresh(); }
  async refresh(): Promise<void> {
    const generation = this.generation, selected = this.selectedId, refreshId = ++this.refreshId;
    const snapshot = await this.json(`/api/ui/snapshot${selected === undefined ? "" : `?selected=${encodeURIComponent(selected)}`}`) as UiSnapshot;
    if (generation !== this.generation || selected !== this.selectedId || refreshId !== this.refreshId) return;
    if (snapshot.version !== 1 || typeof snapshot.hostId !== "string") throw new UiError(409, "不兼容的 UI 协议版本。");
    const previous = this.value.snapshot;
    if (previous?.hostId === snapshot.hostId && snapshot.revision < previous.revision) return;
    this.update({ snapshot, connection: "connected" });
  }
  async command(name: string, args: Record<string, string> = {}, targetId = this.value.snapshot?.selectedId ?? null): Promise<void> {
    const snapshot = this.value.snapshot;
    if (!snapshot || this.value.busy || this.value.connection !== "connected") throw new UiError(409, "当前未连接或已有操作正在提交。");
    const generation = this.generation;
    const command: UiCommand = { version: 1, hostId: snapshot.hostId, requestId: crypto.randomUUID(), name, targetId, args };
    this.update({ busy: true, error: null });
    try {
      const receipt = await this.json("/api/ui/commands", command) as UiReceipt;
      if (generation !== this.generation) return;
      if (receipt.selectedId !== undefined) this.selectedId = receipt.selectedId ?? undefined;
      await this.refresh();
    } catch (error) {
      if (generation === this.generation) this.update({ error: `${describe(error)} 请先检查当前状态；未自动重发命令。` });
      throw error;
    } finally { if (generation === this.generation) this.update({ busy: false }); }
  }
  private async json(path: string, body?: UiCommand): Promise<unknown> {
    const response = await this.request(this.baseUrl + path, {
      method: body ? "POST" : "GET", cache: "no-store", credentials: "omit",
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      signal: this.lifetime?.signal ?? null, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new UiError(response.status, data.error ?? `HTTP ${response.status}`);
    return data;
  }
  private async watch(signal: AbortSignal, generation: number): Promise<void> {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        const response = await this.request(this.baseUrl + "/api/ui/events", { headers: { authorization: `Bearer ${this.token}` }, credentials: "omit", cache: "no-store", signal });
        if (!response.ok || !response.body) throw new UiError(response.status, "实时连接不可用。");
        // The stream carries invalidations, never authoritative state. Every reconnect fetches a full snapshot.
        await this.refresh(); backoff = 500;
        const reader = response.body.getReader();
        try { while (!signal.aborted) { const part = await reader.read(); if (part.done) break; await this.refresh(); } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        if (signal.aborted || generation !== this.generation) return;
        if (error instanceof UiError && error.status === 401) { this.disconnect(); this.update({ error: "连接凭据已失效，请重新连接。" }); return; }
      }
      if (signal.aborted || generation !== this.generation) return;
      this.update({ connection: "reconnecting" });
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, backoff); signal.addEventListener("abort", finish, { once: true });
      });
      backoff = Math.min(backoff * 2, 10_000);
    }
  }
}
function describe(error: unknown): string { return error instanceof Error ? error.message : "连接失败。"; }
