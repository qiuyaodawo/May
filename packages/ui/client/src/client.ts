import { UiError, type UiCommand, type UiReceipt, type UiSnapshot, type UiPage, type UiResource, type UiBlock, type UiField, type UiFieldPage, type UiCommandOutput, type UiCompletion } from "./protocol.js";

export interface UiClientState {
  readonly snapshot: UiSnapshot | null;
  readonly connection: "disconnected" | "connecting" | "connected" | "reconnecting";
  readonly busy: boolean;
  readonly selecting: boolean;
  readonly error: string | null;
  readonly output?: UiCommandOutput | null;
}

/** Browser-safe client. Credentials are memory-only; commands are never auto-retried. */
export class UiClient {
  private token = "";
  private selectedId: string | undefined;
  private lifetime: AbortController | undefined;
  private generation = 0;
  private refreshId = 0;
  private selectionVersion = 0;
  private listeners = new Set<(state: UiClientState) => void>();
  private value: UiClientState = { snapshot: null, connection: "disconnected", busy: false, selecting: false, error: null };
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
    this.selectedId = undefined; this.selectionVersion++;
    this.update({ snapshot: null, connection: "disconnected", busy: false, selecting: false, error: null, output: null });
  }
  async select(id?: string): Promise<void> {
    if (!this.lifetime) throw new UiError(409, "请先连接本地服务。");
    if (this.value.snapshot?.activeId !== undefined) {
      if (id === undefined || id === this.value.snapshot.activeId) { await this.refresh(); return; }
      await this.command("session.activate", {}, id);
      return;
    }
    const version = ++this.selectionVersion, previous = this.value.snapshot?.selectedId ?? undefined;
    this.selectedId = id; this.update({ selecting: true, error: null, output: null });
    try { await this.refresh(); }
    catch (error) { if (version === this.selectionVersion) { this.selectedId = previous; this.update({ error: describe(error) }); } throw error; }
    finally { if (version === this.selectionVersion) this.update({ selecting: false }); }
  }
  async refresh(): Promise<void> {
    const generation = this.generation, selected = this.selectedId, refreshId = ++this.refreshId;
    const snapshot = await this.json(`/api/ui/snapshot${selected === undefined ? "" : `?selected=${encodeURIComponent(selected)}`}`) as UiSnapshot;
    if (generation !== this.generation || selected !== this.selectedId || refreshId !== this.refreshId) return;
    if (snapshot.version !== 1 || typeof snapshot.hostId !== "string") throw new UiError(409, "不兼容的 UI 协议版本。");
    const previous = this.value.snapshot;
    if (previous?.hostId === snapshot.hostId && snapshot.revision < previous.revision) return;
    const changedSelection = previous?.hostId !== snapshot.hostId || previous?.selectedId !== snapshot.selectedId;
    if (snapshot.activeId !== undefined) this.selectedId = snapshot.selectedId ?? undefined;
    if (changedSelection && snapshot.activeId !== undefined) this.selectionVersion++;
    this.update({ snapshot, connection: "connected", ...(changedSelection ? { output: null } : {}) });
  }
  readResources(query = "", cursor?: string): Promise<UiPage<UiResource>> {
    return this.read("resources", { query, ...(cursor ? { cursor } : {}) }, false);
  }
  complete(text: string): Promise<{ hostId: string; items: readonly UiCompletion[] }> { return this.read("complete", { text }); }
  async interact(name: string, args: Record<string, string> = {}): Promise<void> {
    const snapshot = this.value.snapshot, generation = this.generation;
    if (!snapshot || this.value.connection !== "connected" || this.value.selecting || !snapshot.commands.includes(name) || ![snapshot.controls?.responseCommand, snapshot.controls?.cancelCommand].includes(name)) throw new UiError(409, "当前交互已不可用。");
    const command: UiCommand = { version: 1, hostId: snapshot.hostId, requestId: crypto.randomUUID(), name, targetId: snapshot.activeId ?? snapshot.selectedId, args };
    await this.json("/api/ui/commands", command);
    if (generation === this.generation) await this.refresh();
  }
  readHistory(query = "", cursor?: string): Promise<UiPage<UiBlock>> {
    return this.read("history", { query, ...(cursor ? { cursor } : {}) });
  }
  readField(blockId: string, field: UiField, offset = 0, version?: string): Promise<UiFieldPage> {
    return this.read("field", { block: blockId, field, offset: String(offset), ...(version ? { version } : {}) });
  }
  private async read<T extends { hostId: string }>(kind: string, args: Record<string, string>, scoped = true): Promise<T> {
    const snapshot = this.value.snapshot, generation = this.generation, selection = this.selectionVersion;
    if (!snapshot || this.value.connection !== "connected" || scoped && (this.value.selecting || !snapshot.selectedId)) throw new UiError(409, "请先连接并选择资源。");
    const params = new URLSearchParams({ ...args, hostId: snapshot.hostId, ...(scoped ? { selected: snapshot.selectedId! } : {}) });
    const result = await this.json(`/api/ui/${kind}?${params}`) as T;
    if (generation !== this.generation || result.hostId !== this.value.snapshot?.hostId || scoped && (selection !== this.selectionVersion || snapshot.selectedId !== this.value.snapshot?.selectedId)) throw new UiError(409, "浏览对象已改变，已忽略旧读取结果。");
    return result;
  }
  async command(name: string, args: Record<string, string> = {}, targetId = this.value.snapshot?.selectedId ?? null): Promise<void> {
    const snapshot = this.value.snapshot;
    if (!snapshot || this.value.busy || this.value.selecting || (this.selectedId !== undefined && this.selectedId !== snapshot.selectedId) || this.value.connection !== "connected") throw new UiError(409, "当前未连接、正在浏览切换或已有操作正在提交。");
    const generation = this.generation, selectionVersion = this.selectionVersion;
    const command: UiCommand = { version: 1, hostId: snapshot.hostId, requestId: crypto.randomUUID(), name, targetId, ...(snapshot.activeId === undefined ? {} : { expectedActiveId: snapshot.activeId }), args };
    this.update({ busy: true, error: null });
    try {
      const receipt = await this.json("/api/ui/commands", command) as UiReceipt;
      if (generation !== this.generation) return;
      if (receipt.disconnect) { this.disconnect(); return; }
      if (selectionVersion === this.selectionVersion) this.update({ output: receipt.output ?? null });
      if (selectionVersion === this.selectionVersion && receipt.selectedId !== undefined) this.selectedId = receipt.selectedId ?? undefined;
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
