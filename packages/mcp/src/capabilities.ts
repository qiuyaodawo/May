import { UriTemplate, type Client, type ReadResourceResult, type RequestOptions, type McpSubscription } from "@modelcontextprotocol/client";
import { AsyncEventQueue } from "@may/core";
import { McpCapabilityError } from "./errors.js";
import { assertMcpContentSize, mcpPromptToUserMessage, mcpResourceToUserMessage } from "./content.js";
import type {
  McpCompletion, McpCompletionParams, McpOperationOptions, McpPromptExpansion, McpReadOptions,
  McpResourceRead, McpResourceSubscription, McpServerCatalog, McpServerOptions,
} from "./types.js";

export type McpOperationRunner = <T>(method: string, options: McpOperationOptions,
  work: (options: RequestOptions) => Promise<T>) => Promise<T>;

interface Watch {
  finish(reason: "local" | "remote" | "connection-closed"): void;
  close(): Promise<void>;
  push(): void;
}

/** One connection/authorization generation, no shared or persistent content cache. */
export class McpCapabilities {
  private readonly cache = new Map<string, { result: ReadResourceResult; expiresAt: number; bytes: number }>();
  private cacheBytes = 0;
  private generation = 0;
  private readonly watches = new Map<string, Set<Watch>>();
  private watchCount = 0;
  private readonly remoteWatches = new Map<string, McpSubscription>();
  private watchChain = Promise.resolve();
  private closed = false;
  private catalog: McpServerCatalog | undefined;
  private completionWindow = 0;
  private completionCount = 0;

  constructor(private readonly client: Client, private readonly server: McpServerOptions, private readonly run: McpOperationRunner) {
    client.setNotificationHandler("notifications/resources/updated", (notification) => {
      const uri = notification.params.uri;
      this.generation++;
      this.evict(uri);
      for (const watch of this.watches.get(uri) ?? []) watch.push();
    });
  }

  updateCatalog(catalog: McpServerCatalog): void { this.catalog = catalog; this.invalidate(); }

  invalidate(): void { this.generation++; this.cache.clear(); this.cacheBytes = 0; }

  readResource(uri: string, options: McpReadOptions = {}): Promise<McpResourceRead> {
    validUri(uri);
    if (options.cache !== undefined && !["use", "refresh", "bypass"].includes(options.cache)) throw new TypeError("Invalid MCP cache mode");
    this.require("resources");
    return this.run("resources/read", options, async (request) => {
      const cached = this.cache.get(uri);
      if ((options.cache ?? "use") === "use" && cached !== undefined && cached.expiresAt > Date.now()) {
        this.cache.delete(uri); this.cache.set(uri, cached);
        return { serverId: this.server.id, uri, result: cached.result, fromCache: true };
      }
      this.evict(uri);
      const generation = this.generation;
      const result = await this.client.readResource({ uri }, { ...request, cacheMode: "bypass" });
      const read = { serverId: this.server.id, uri, result, fromCache: false };
      // Validate even for preview-only consumers. Nothing silently disappears on attachment.
      mcpResourceToUserMessage(read);
      const immutable = freezeTree(structuredClone(result));
      const ttl = typeof result.ttlMs === "number" ? Math.min(Math.max(result.ttlMs, 0), 300_000) : 0;
      if (options.cache !== "bypass" && ttl > 0 && generation === this.generation && !this.closed) {
        const bytes = Buffer.byteLength(JSON.stringify(immutable));
        while (this.cache.size >= 32 || this.cacheBytes + bytes > 16 * 1024 * 1024) this.evict(this.cache.keys().next().value!);
        this.cache.set(uri, { result: immutable, expiresAt: Date.now() + ttl, bytes });
        this.cacheBytes += bytes;
      }
      return { ...read, result: immutable };
    });
  }

  readTemplate(template: string, variables: Readonly<Record<string, string | string[]>>, options?: McpReadOptions): Promise<McpResourceRead> {
    if (!this.catalog?.resourceTemplates.some((entry) => entry.uriTemplate === template)) this.invalid("unknown resource template");
    assertMcpContentSize(variables);
    const parsed = new UriTemplate(template);
    for (const [key, value] of Object.entries(variables)) {
      if (!parsed.variableNames.includes(key) || !(typeof value === "string" || Array.isArray(value) && value.every((part) => typeof part === "string"))) this.invalid("invalid resource template arguments");
    }
    return this.readResource(parsed.expand(variables as Record<string, string | string[]>), options);
  }

  getPrompt(name: string, args: Readonly<Record<string, string>> = {}, options: McpOperationOptions = {}): Promise<McpPromptExpansion> {
    this.require("prompts");
    const prompt = this.catalog?.prompts.find((entry) => entry.name === name);
    if (prompt === undefined) this.invalid("unknown prompt");
    validArguments(args);
    const declared = prompt.arguments ?? [];
    if (Object.keys(args).some((name) => !declared.some((argument) => argument.name === name)) ||
        declared.some((argument) => argument.required && !Object.hasOwn(args, argument.name))) this.invalid("invalid or missing prompt arguments");
    const argumentsCopy = { ...args };
    return this.run("prompts/get", options, async (request) => {
      const result = await this.client.getPrompt({ name, arguments: argumentsCopy }, request);
      const expansion = { serverId: this.server.id, name, arguments: argumentsCopy, result };
      mcpPromptToUserMessage(expansion);
      return freezeTree(structuredClone(expansion));
    });
  }

  complete(params: McpCompletionParams, options: McpOperationOptions = {}): Promise<McpCompletion> {
    this.require("completions");
    validArguments(params.context?.arguments ?? {});
    if (typeof params.argument?.name !== "string" || params.argument.name.length > 128 || typeof params.argument.value !== "string" || params.argument.value.length > 4096) this.invalid("invalid completion argument");
    const ref = params.ref;
    const argumentNames = ref.type === "ref/prompt"
      ? this.catalog?.prompts.find((prompt) => prompt.name === ref.name)?.arguments?.map((argument) => argument.name)
      : this.catalog?.resourceTemplates.some((template) => template.uriTemplate === ref.uri) ? new UriTemplate(ref.uri).variableNames
        : this.catalog?.resources.some((resource) => resource.uri === ref.uri) ? [params.argument.name, ...Object.keys(params.context?.arguments ?? {})] : undefined;
    if (!argumentNames?.includes(params.argument.name) || Object.keys(params.context?.arguments ?? {}).some((name) => !argumentNames.includes(name))) this.invalid("unknown completion reference or argument");
    if (Date.now() - this.completionWindow >= 1000) { this.completionWindow = Date.now(); this.completionCount = 0; }
    if (++this.completionCount > 10) this.invalid("completion rate limit exceeded");
    const copy = structuredClone(params);
    return this.run("completion/complete", options, async (request) => {
      const { completion } = await this.client.complete(copy, request);
      if (completion.values.length > 100 || Buffer.byteLength(JSON.stringify(completion)) > 64 * 1024) this.invalid("completion exceeds host limits");
      return freezeTree(structuredClone(completion));
    });
  }

  subscribe(uri: string, options: McpOperationOptions = {}): Promise<McpResourceSubscription> {
    validUri(uri);
    this.require("resources");
    if (this.catalog?.capabilities.resources?.subscribe !== true) this.invalid("resource subscriptions are not supported", "MCP_CAPABILITY_UNSUPPORTED");
    // Serialize legacy per-URI refcounts, but never tool execution or UI responses.
    const pending = this.watchChain.then(() => this.run("resources/subscribe", options, async (request) => {
      if (this.closed || this.watchCount >= 64) this.invalid("resource subscription limit reached or connection closed");
      const modern = this.client.getProtocolEra() === "modern";
      const existing = this.watches.get(uri);
      let remote = this.remoteWatches.get(uri);
      if (modern && existing === undefined) {
        // A caller owns its handle, not other handles sharing the remote URI stream.
        // Relay cancellation only during acknowledgement, then detach it.
        const opening = new AbortController();
        const abortOpening = () => opening.abort(request.signal?.reason);
        if (request.signal?.aborted) abortOpening();
        request.signal?.addEventListener("abort", abortOpening, { once: true });
        try { remote = await this.client.listen({ resourceSubscriptions: [uri] }, { ...request, signal: opening.signal }); }
        finally { request.signal?.removeEventListener("abort", abortOpening); }
      }
      if (remote !== undefined && !remote.honoredFilter.resourceSubscriptions?.includes(uri)) {
        await remote.close(); this.invalid("server did not accept resource subscription", "MCP_CAPABILITY_UNSUPPORTED");
      }
      if (!modern && existing === undefined) await this.client.subscribeResource({ uri }, request);
      const queue = new AsyncEventQueue<{ type: "updated"; serverId: string; uri: string }>({ maxBufferedValues: 32, isDroppable: () => true });
      let resolveClosed!: (reason: "local" | "remote" | "connection-closed") => void;
      const closed = new Promise<"local" | "remote" | "connection-closed">((resolve) => { resolveClosed = resolve; });
      let ended = false;
      let closePromise: Promise<void> | undefined;
      const abort = () => { void watch.close().catch(() => {}); };
      const watch: Watch = {
        push: () => { if (!ended) queue.push({ type: "updated", serverId: this.server.id, uri }); },
        finish: (reason) => {
          if (ended) return;
          ended = true;
          options.signal?.removeEventListener("abort", abort);
          this.watches.get(uri)?.delete(watch);
          if (this.watches.get(uri)?.size === 0) this.watches.delete(uri);
          this.watchCount--;
          queue.close(); resolveClosed(reason);
        },
        close: () => {
          closePromise ??= this.endWatch(uri, watch);
          return closePromise;
        },
      };
      const watchers = existing ?? new Set<Watch>();
      watchers.add(watch); this.watches.set(uri, watchers); this.watchCount++;
      options.signal?.addEventListener("abort", abort, { once: true });
      if (remote !== undefined && existing === undefined) {
        this.remoteWatches.set(uri, remote);
        void remote.closed.then(() => {
          if (this.remoteWatches.get(uri) !== remote) return;
          this.remoteWatches.delete(uri);
          for (const watcher of [...(this.watches.get(uri) ?? [])]) watcher.finish("remote");
        });
      }
      if (options.signal?.aborted || this.closed) void watch.close().catch(() => {});
      return { serverId: this.server.id, uri, events: queue, closed, close: watch.close };
    }));
    this.watchChain = pending.then(() => {}, () => {});
    return pending;
  }

  async close(): Promise<void> {
    this.closed = true; this.invalidate();
    // Connection shutdown owns the transport; handles finish locally without extra auth/network waits.
    for (const watchers of this.watches.values()) for (const watch of [...watchers]) watch.finish("connection-closed");
    this.remoteWatches.clear();
    await this.watchChain;
  }

  private async endWatch(uri: string, watch: Watch): Promise<void> {
    // Refcount change and unsubscribe share the same queue as subscription creation.
    const pending = this.watchChain.then(async () => {
      const registered = this.watches.get(uri)?.has(watch) === true;
      watch.finish("local");
      const remote = this.remoteWatches.get(uri);
      if (remote !== undefined) {
        if (!this.watches.has(uri)) { this.remoteWatches.delete(uri); await remote.close(); }
        return;
      }
      if (registered && !this.closed && !this.watches.has(uri)) {
        await this.run("resources/unsubscribe", {}, (request) => this.client.unsubscribeResource({ uri }, request));
      }
    });
    this.watchChain = pending.catch(() => {});
    return pending;
  }

  private require(capability: "resources" | "prompts" | "completions"): void {
    if (this.closed) this.invalid("connection is closed");
    if (this.catalog?.capabilities[capability] === undefined) this.invalid(`capability ${capability} is not supported`, "MCP_CAPABILITY_UNSUPPORTED");
  }
  private invalid(message: string, code?: string): never { throw new McpCapabilityError(this.server.id, message, code); }
  private evict(uri: string): void {
    const entry = this.cache.get(uri);
    if (entry !== undefined) { this.cacheBytes -= entry.bytes; this.cache.delete(uri); }
  }
}

function validUri(uri: string): void {
  if (typeof uri !== "string" || uri.length > 8192 || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\u0000-\u0020\u007f]*$/u.test(uri)) throw new TypeError("MCP resource URI must be an absolute bounded URI");
}
function validArguments(args: Readonly<Record<string, string>>): void {
  if (typeof args !== "object" || args === null || Array.isArray(args) || Object.keys(args).length > 128 ||
      Object.values(args).some((value) => typeof value !== "string") || Buffer.byteLength(JSON.stringify(args)) > 64 * 1024) throw new TypeError("MCP arguments must be a bounded string map");
}
function freezeTree<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freezeTree(child);
  }
  return value;
}
