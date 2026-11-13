import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  createProtocolConnection,
  type ServerCapabilities,
  type Diagnostic,
  type Location,
  type LocationLink,
  type Range,
  type WorkspaceEdit,
  type DocumentSymbol,
  type SymbolInformation,
  type WorkspaceSymbol,
  type Hover,
} from "vscode-languageserver-protocol/node";
import {
  CancellationTokenSource,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
  Trace,
} from "vscode-jsonrpc/node";
import { URI } from "vscode-uri";
import {
  createReadTool,
  resolveExistingWorkspacePath,
  type WorkspacePath,
  type WorkspaceFileFeedback,
  type WorkspaceFileFeedbackTicket,
  type WorkspaceFileGuard,
} from "@sortedyuan/coding-tools";
import type {
  FileDiagnostics,
  LanguageServerManager,
  LanguageServerManagerOptions,
  LanguageServerStatus,
  LspLocation,
  RenamePlan,
  RenameOutput,
  SymbolPosition,
  SymbolList,
  LspSymbol,
} from "./types.js";
import { LspProtocolError, LspServerExitedError, LspTimeoutError } from "./errors.js";
import { resolveServerCommand, serverDefinition } from "./presets.js";
import { RenameTransactions } from "./rename-transaction.js";
import {
  CLIENT_CAPABILITIES,
  createServerState,
  registerClientHandlers,
  watchedChanges,
  type ServerState,
} from "./server-session.js";
import { hash, message, tail } from "./text.js";

class Manager implements LanguageServerManager {
  readonly fileFeedback: WorkspaceFileFeedback;
  private readonly servers = new Map<string, ServerState>();
  private readonly extensions = new Map<string, { server: ServerState; language: string }>();
  private readonly options: LanguageServerManagerOptions;
  private readonly limits: Record<
    | "startTimeoutMs"
    | "requestTimeoutMs"
    | "diagnosticsTimeoutMs"
    | "shutdownTimeoutMs"
    | "maxFileBytes"
    | "maxResults"
    | "maxHoverChars"
    | "maxEditDiagnostics"
    | "maxDiagnostics"
    | "maxServers",
    number
  >;
  private readonly renames: RenameTransactions;
  private watcher: FSWatcher | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changes = new Set<string>();
  private closed = false;
  private recovery: string | undefined;
  private lifecycle: Promise<unknown> = Promise.resolve();

  constructor(options: LanguageServerManagerOptions) {
    this.options = options;
    this.limits = {
      startTimeoutMs: 60000,
      requestTimeoutMs: 15000,
      diagnosticsTimeoutMs: 3000,
      shutdownTimeoutMs: 5000,
      maxFileBytes: 1048576,
      maxResults: 200,
      maxHoverChars: 8000,
      maxEditDiagnostics: 20,
      maxDiagnostics: 200,
      maxServers: 4,
    };
    for (const key of Object.keys(this.limits) as (keyof typeof this.limits)[]) {
      const value = options[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${key} must be a positive integer`);
        this.limits[key] = value;
      }
    }
    this.renames = new RenameTransactions(
      join(options.dataDirectory, "lsp-rename", `${hash(options.execution.workspace)}.json`),
      { path: (input) => this.path(input), read: (path, signal) => this.read(path, signal) },
    );
    for (const input of options.servers) {
      const definition = serverDefinition(input);
      if (this.servers.has(definition.id)) throw new TypeError(`Duplicate server ${definition.id}`);
      const server = createServerState(definition);
      this.servers.set(definition.id, server);
      for (const [language, extensions] of Object.entries(definition.languages)) {
        for (const extension of extensions) {
          const key = extension.toLowerCase();
          if (this.extensions.has(key)) throw new TypeError(`Duplicate language extension ${key}`);
          this.extensions.set(key, { server, language });
        }
      }
    }
    this.fileFeedback = { record: (path, content) => this.record(path, content) };
  }

  async open(): Promise<void> {
    this.recovery = await this.renames.recover();
    this.watcher = watch(this.options.execution.workspace, { recursive: true }, (_event, name) => {
      if (!name || name.toString().replace(/\\/gu, "/").split("/").includes(".git")) return;
      this.changes.add(name.toString());
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        this.watchTimer = undefined;
        const paths = [...this.changes];
        this.changes.clear();
        for (const server of this.servers.values()) {
          if (server.state === "running")
            this.background(
              server,
              this.enqueue(server, () => this.watched(server, paths)),
            );
        }
      }, 200);
    });
    this.watcher.on("error", (error) => {
      for (const server of this.servers.values()) server.lastError = message(error);
    });
  }

  status(): readonly LanguageServerStatus[] {
    return [...this.servers.values()].map((server) => ({
      id: server.definition.id,
      languages: server.definition.languages,
      state: server.state,
      ...(server.resolved ?? { command: server.definition.command, args: server.definition.args }),
      ...(server.child?.pid && server.child.exitCode === null && server.child.signalCode === null
        ? { pid: server.child.pid }
        : {}),
      progress: [...server.progress.values()],
      ...(server.lastError ? { lastError: server.lastError } : {}),
      stderr: server.stderr,
      logs: server.logs,
      ...(this.recovery ? { recovery: this.recovery } : {}),
    }));
  }

  private async path(input: string): Promise<WorkspacePath> {
    return resolveExistingWorkspacePath(this.options.execution.workspace, input);
  }
  private async read(path: WorkspacePath, signal: AbortSignal): Promise<string> {
    // Reuse coding-tools' UTF-8, regular-file and byte-limit validation.
    const tool = createReadTool({
      cwd: this.options.execution.workspace,
      maxBytes: this.limits.maxFileBytes,
      maxLines: this.limits.maxFileBytes + 1,
      allowHardLinks: false,
    });
    const output = await tool.execute(
      { path: path.relative },
      { signal, runId: "lsp", step: 0, toolCallId: "lsp-read", idempotencyKey: "lsp-read", report() {} },
    );
    return output.content;
  }
  private select(path: WorkspacePath) {
    const selected = this.extensions.get(extname(path.absolute).toLowerCase());
    if (!selected) throw new Error(`No configured language server for ${path.relative}`);
    return selected;
  }
  private uri(path: WorkspacePath): string {
    const environmentPath = this.options.execution.toEnvironmentPath(path.absolute);
    return (
      this.options.execution.isolation.mode === "host"
        ? URI.file(environmentPath)
        : URI.from({ scheme: "file", path: environmentPath })
    ).toString();
  }
  private hostUri(uri: string): { host?: string; environmentPath: string } {
    const value = URI.parse(uri);
    if (value.scheme !== "file") throw new LspProtocolError(`Unsupported URI: ${uri}`);
    const environmentPath = this.options.execution.isolation.mode === "host" ? value.fsPath : value.path;
    const host = this.options.execution.toHostPath(environmentPath);
    return { ...(host ? { host } : {}), environmentPath };
  }
  private busy(server: ServerState) {
    return server.progress.size ? { serverBusy: { titles: [...server.progress.values()] } } : {};
  }
  private background(server: ServerState, promise: Promise<unknown>): void {
    promise.catch((error: unknown) => {
      server.lastError = message(error);
    });
  }
  private enqueue<T>(server: ServerState, operation: () => Promise<T>): Promise<T> {
    const result = server.sync.then(operation);
    server.sync = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    let abort = () => {};
    const cancelled = new Promise<never>((_accept, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([promise, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private async ensure(server: ServerState): Promise<void> {
    if (this.closed) throw new Error("Language server manager is closed");
    server.used = Date.now();
    if (server.state === "failed")
      throw new LspServerExitedError(server.lastError ?? `Server ${server.definition.id} failed`);
    if (server.state === "running") return;
    if (server.starting) return server.starting;
    server.starting = this.lifecycle.then(async () => {
      const running = [...this.servers.values()].filter((candidate) => candidate.state === "running");
      if (running.length >= this.limits.maxServers) await this.stop(running.sort((a, b) => a.used - b.used)[0]!);
      await this.start(server);
    });
    this.lifecycle = server.starting.then(
      () => {},
      () => {},
    );
    try {
      await server.starting;
    } finally {
      delete server.starting;
    }
  }

  private async start(server: ServerState): Promise<void> {
    server.state = "starting";
    server.stopping = false;
    const controller = new AbortController();
    server.controller = controller;
    try {
      const resolved = await resolveServerCommand(server.definition, this.options.execution);
      if (this.closed) throw new Error("Language server manager is closed");
      server.resolved = resolved;
      const child = this.options.execution.spawn(resolved.command, resolved.args, {
        cwd: this.options.execution.workspace,
        signal: controller.signal,
        stdin: "pipe",
        ...(server.definition.env ? { env: server.definition.env } : {}),
      });
      server.child = child;
      child.stderr!.on("data", (data: Buffer) => {
        server.stderr = tail(server.stderr + data.toString());
      });
      const connection = createProtocolConnection(
        new StreamMessageReader(child.stdout!),
        new StreamMessageWriter(child.stdin!),
      );
      server.connection = connection;
      await connection.trace(Trace.Messages, {
        log: (entry: string) => {
          server.logs = tail(server.logs + entry + "\n");
        },
      });
      const folder = {
        uri: this.uri({ absolute: this.options.execution.workspace, relative: "." }),
        name: "workspace",
      };
      registerClientHandlers(connection, server, this.options.execution.workspace, folder);
      child.on("error", (error) => {
        server.lastError = message(error);
      });
      let exited = false;
      const onExit = (code: number | null, signal: string | null) => {
        if (exited) return;
        exited = true;
        if (server.child !== child) return;
        if (!server.stopping) {
          server.exits = Date.now() - server.startedAt < 60000 ? server.exits + 1 : 1;
          server.lastError = `Server ${server.definition.id} exited (${code ?? signal}): ${server.stderr}`;
          server.state = server.exits >= 3 ? "failed" : "stopped";
        } else server.state = "stopped";
        connection.dispose();
        server.progress.clear();
        server.watchers.clear();
        server.knownFiles.clear();
        server.diagnostics.clear();
        for (const document of server.documents.values()) document.sentVersion = 0;
        for (const wake of server.waiters) wake();
      };
      child.once("exit", onExit);
      connection.onClose(() => {
        onExit(child.exitCode, child.signalCode);
        if (!server.stopping) controller.abort();
      });
      connection.listen();
      server.startedAt = Date.now();
      const result = await this.request<{ capabilities: ServerCapabilities }>(
        server,
        "initialize",
        {
          processId: this.options.execution.isolation.mode === "host" ? process.pid : null,
          clientInfo: { name: "may" },
          rootUri: folder.uri,
          workspaceFolders: [folder],
          initializationOptions: server.definition.initializationOptions,
          capabilities: CLIENT_CAPABILITIES,
        },
        controller.signal,
        this.limits.startTimeoutMs,
        false,
      );
      if (result.capabilities.positionEncoding && result.capabilities.positionEncoding !== "utf-16")
        throw new LspProtocolError(
          `Server ${server.definition.id} selected unsupported encoding ${result.capabilities.positionEncoding}`,
        );
      server.capabilities = result.capabilities;
      await connection.sendNotification("initialized", {});
      await connection.sendNotification("workspace/didChangeConfiguration", {
        settings: server.definition.settings ?? {},
      });
      server.generation++;
      server.state = "running";
    } catch (error) {
      server.lastError = message(error);
      controller.abort();
      if (server.exits < 3) server.state = "stopped";
      throw error;
    }
  }

  private async request<T>(
    server: ServerState,
    method: string,
    params: unknown,
    signal: AbortSignal,
    timeout = this.limits.requestTimeoutMs,
    retry = true,
  ): Promise<T> {
    signal.throwIfAborted();
    const connection = server.connection;
    if (!connection) throw new LspServerExitedError(`Server ${server.definition.id} has no connection`);
    const token = new CancellationTokenSource();
    let timedOut = false;
    let rejectCancellation: (error: unknown) => void = () => {};
    const cancelled = new Promise<never>((_accept, reject) => {
      rejectCancellation = reject;
    });
    const cancel = () => {
      token.cancel();
      rejectCancellation(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      token.cancel();
      rejectCancellation(
        new LspTimeoutError(
          `${method} timed out on ${server.definition.id}; progress: ${[...server.progress.values()].join(", ")}`,
        ),
      );
    }, timeout);
    try {
      return await Promise.race([connection.sendRequest<T>(method, params, token.token), cancelled]);
    } catch (error) {
      if (timedOut || signal.aborted) throw error;
      if (
        server.child?.exitCode !== null ||
        server.child?.signalCode !== null ||
        server.state === "failed" ||
        server.state === "stopped"
      )
        throw new LspServerExitedError(server.lastError ?? `Server ${server.definition.id} exited`, { cause: error });
      if (
        retry &&
        error instanceof ResponseError &&
        (error.code === -32801 ||
          (method === "textDocument/diagnostic" &&
            error.code === -32802 &&
            (error.data as { retriggerRequest?: boolean } | undefined)?.retriggerRequest === true))
      ) {
        await this.synchronize(server, signal);
        return this.request<T>(server, method, params, signal, timeout, false);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      token.dispose();
    }
  }

  private async sendDocument(
    server: ServerState,
    path: WorkspacePath,
    content: string,
    version: number,
    save: boolean,
    touch = true,
  ): Promise<void> {
    const uri = this.uri(path);
    const document = server.documents.get(uri)!;
    const languageId = this.select(path).language;
    if (document.sentVersion === 0)
      await server.connection!.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text: content },
      });
    else if (document.sentVersion < version)
      await server.connection!.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }],
      });
    if (document.sentVersion !== version) server.logs = tail(server.logs + `Document sync ${uri} version ${version}\n`);
    document.sentVersion = version;
    if (touch) document.used = Date.now();
    const sync = server.capabilities.textDocumentSync;
    if (save && typeof sync === "object" && sync.save)
      await server.connection!.sendNotification("textDocument/didSave", {
        textDocument: { uri },
        ...(typeof sync.save === "object" && sync.save.includeText ? { text: content } : {}),
      });
    const opened = [...server.documents.entries()].filter(([, doc]) => doc.sentVersion > 0);
    if (opened.length > 64) {
      const oldest = opened
        .filter(([key, doc]) => key !== uri && doc.pending === 0)
        .sort((a, b) => a[1].used - b[1].used)[0];
      if (!oldest) throw new Error("Document capacity exhausted by pending writes");
      await server.connection!.sendNotification("textDocument/didClose", { textDocument: { uri: oldest[0] } });
      server.documents.delete(oldest[0]);
      server.diagnostics.delete(oldest[0]);
    }
  }
  private async synchronize(server: ServerState, signal: AbortSignal, target?: WorkspacePath): Promise<void> {
    for (const [uri, document] of [...server.documents]) {
      signal.throwIfAborted();
      const exists = await stat(document.path.absolute).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      if (!exists) {
        if (document.sentVersion)
          await server.connection!.sendNotification("textDocument/didClose", { textDocument: { uri } });
        server.documents.delete(uri);
        server.diagnostics.delete(uri);
        continue;
      }
      const content = await this.read(document.path, signal);
      const changed = hash(content) !== hash(document.content);
      if (changed) {
        document.content = content;
        document.version++;
        server.diagnostics.delete(uri);
      }
      await this.sendDocument(server, document.path, document.content, document.version, changed, false);
    }
    if (target && !server.documents.has(this.uri(target))) {
      const content = await this.read(target, signal);
      server.documents.set(this.uri(target), {
        path: target,
        content,
        version: 1,
        sentVersion: 0,
        used: Date.now(),
        pending: 0,
      });
      await this.sendDocument(server, target, content, 1, false);
    }
    if (target) server.documents.get(this.uri(target))!.used = Date.now();
  }
  private async prepare(path: WorkspacePath, signal: AbortSignal): Promise<ServerState> {
    const { server } = this.select(path);
    await this.cancellable(
      this.enqueue(server, async () => {
        await this.ensure(server);
        await this.synchronize(server, signal, path);
      }),
      signal,
    );
    return server;
  }
  private async position(input: SymbolPosition, signal: AbortSignal) {
    const path = await this.path(input.path);
    const server = await this.prepare(path, signal);
    const document = server.documents.get(this.uri(path))!;
    const lines = document.content.split(/\r\n|\r|\n/u);
    if (!Number.isSafeInteger(input.line) || input.line < 1 || input.line > lines.length)
      throw new RangeError(`Line ${input.line} does not exist in ${path.relative}`);
    const line = lines[input.line - 1]!;
    let character: number;
    if ((input.column === undefined) === (input.symbol === undefined))
      throw new TypeError("Provide exactly one of symbol or column");
    if (input.column !== undefined) {
      if (
        input.occurrence !== undefined ||
        !Number.isSafeInteger(input.column) ||
        input.column < 1 ||
        input.column > line.length + 1
      )
        throw new RangeError(`Invalid column; line: ${line}`);
      character = input.column - 1;
    } else {
      if (!input.symbol) throw new TypeError("symbol must not be empty");
      const occurrence = input.occurrence ?? 1;
      if (!Number.isSafeInteger(occurrence) || occurrence < 1)
        throw new TypeError("occurrence must be a positive integer");
      character = -1;
      for (let count = 0; count < occurrence; count++) {
        character = line.indexOf(input.symbol, character + 1);
        if (character < 0)
          throw new RangeError(`Symbol ${input.symbol} occurrence ${occurrence} not found; line: ${line}`);
      }
    }
    return {
      server,
      path,
      params: { textDocument: { uri: this.uri(path) }, position: { line: input.line - 1, character } },
    };
  }
  private supports(server: ServerState, key: keyof ServerCapabilities, method: string): void {
    if (!server.capabilities[key]) throw new Error(`Server ${server.definition.id} does not support ${method}`);
  }

  private async location(uri: string, range: Range, signal: AbortSignal): Promise<LspLocation> {
    const mapped = this.hostUri(uri);
    if (!mapped.host) return { outsideWorkspace: true, environmentPath: mapped.environmentPath };
    const path = await this.path(mapped.host);
    const content = await this.read(path, signal);
    return {
      path: path.relative,
      line: range.start.line + 1,
      column: range.start.character + 1,
      endLine: range.end.line + 1,
      endColumn: range.end.character + 1,
      preview: (content.split(/\r\n|\r|\n/u)[range.start.line] ?? "").slice(0, 200),
    };
  }
  async definition(input: SymbolPosition, signal: AbortSignal): Promise<readonly LspLocation[]> {
    const { server, params } = await this.position(input, signal);
    this.supports(server, "definitionProvider", "textDocument/definition");
    const response = await this.request<Location | Location[] | LocationLink[] | null>(
      server,
      "textDocument/definition",
      params,
      signal,
    );
    return Promise.all(
      (response ? (Array.isArray(response) ? response : [response]) : [])
        .slice(0, this.limits.maxResults)
        .map((entry) =>
          "targetUri" in entry
            ? this.location(entry.targetUri, entry.targetSelectionRange, signal)
            : this.location(entry.uri, entry.range, signal),
        ),
    );
  }
  async references(input: SymbolPosition, includeDeclaration: boolean, signal: AbortSignal) {
    const { server, params } = await this.position(input, signal);
    this.supports(server, "referencesProvider", "textDocument/references");
    const locations =
      (await this.request<Location[] | null>(
        server,
        "textDocument/references",
        { ...params, context: { includeDeclaration } },
        signal,
      )) ?? [];
    return {
      locations: await Promise.all(
        locations.slice(0, this.limits.maxResults).map((entry) => this.location(entry.uri, entry.range, signal)),
      ),
      truncated: locations.length > this.limits.maxResults,
      ...this.busy(server),
    };
  }
  async hover(input: SymbolPosition, signal: AbortSignal) {
    const { server, params } = await this.position(input, signal);
    this.supports(server, "hoverProvider", "textDocument/hover");
    const response = await this.request<Hover | null>(server, "textDocument/hover", params, signal);
    const contents = response?.contents;
    const render = (part: string | { value: string }) => (typeof part === "string" ? part : part.value);
    const text = !contents ? "" : Array.isArray(contents) ? contents.map(render).join("\n\n") : render(contents);
    return {
      text: text.slice(0, this.limits.maxHoverChars),
      truncated: text.length > this.limits.maxHoverChars,
      ...this.busy(server),
    };
  }
  private async symbols(
    entries: readonly (DocumentSymbol | SymbolInformation | WorkspaceSymbol)[],
    uri: string | undefined,
    server: ServerState,
    signal: AbortSignal,
  ): Promise<SymbolList> {
    const flat: { symbol: DocumentSymbol | SymbolInformation | WorkspaceSymbol; uri: string; range: Range }[] = [];
    const visit = (items: readonly (DocumentSymbol | SymbolInformation | WorkspaceSymbol)[]) => {
      for (const symbol of items) {
        if ("selectionRange" in symbol) {
          flat.push({ symbol, uri: uri!, range: symbol.selectionRange });
          if (symbol.children) visit(symbol.children);
        } else {
          if (!("range" in symbol.location))
            throw new LspProtocolError("Workspace symbol has no range; resolve is not supported");
          flat.push({ symbol, uri: symbol.location.uri, range: symbol.location.range });
        }
      }
    };
    visit(entries);
    const symbols: LspSymbol[] = await Promise.all(
      flat.slice(0, this.limits.maxResults).map(async (entry) => ({
        name: entry.symbol.name,
        kind: entry.symbol.kind,
        location: await this.location(entry.uri, entry.range, signal),
        ...("containerName" in entry.symbol && entry.symbol.containerName
          ? { containerName: entry.symbol.containerName }
          : {}),
      })),
    );
    return { symbols, truncated: flat.length > this.limits.maxResults, ...this.busy(server) };
  }
  async documentSymbols(input: string, signal: AbortSignal): Promise<SymbolList> {
    const path = await this.path(input);
    const server = await this.prepare(path, signal);
    this.supports(server, "documentSymbolProvider", "textDocument/documentSymbol");
    return this.symbols(
      (await this.request<(DocumentSymbol | SymbolInformation)[] | null>(
        server,
        "textDocument/documentSymbol",
        { textDocument: { uri: this.uri(path) } },
        signal,
      )) ?? [],
      this.uri(path),
      server,
      signal,
    );
  }
  async workspaceSymbols(language: string, query: string, signal: AbortSignal): Promise<SymbolList> {
    const server = this.servers.get(language);
    if (!server) throw new Error(`No configured server ${language}`);
    await this.cancellable(
      this.enqueue(server, async () => {
        await this.ensure(server);
        await this.synchronize(server, signal);
      }),
      signal,
    );
    this.supports(server, "workspaceSymbolProvider", "workspace/symbol");
    return this.symbols(
      (await this.request<(SymbolInformation | WorkspaceSymbol)[] | null>(
        server,
        "workspace/symbol",
        { query },
        signal,
      )) ?? [],
      undefined,
      server,
      signal,
    );
  }

  private record(path: WorkspacePath, content: string): WorkspaceFileFeedbackTicket | undefined {
    const selected = this.extensions.get(extname(path.absolute).toLowerCase());
    if (!selected) return undefined;
    const { server } = selected;
    const uri = this.uri(path);
    const previous = server.documents.get(uri);
    const version = (previous?.version ?? 0) + 1;
    server.documents.set(uri, {
      path,
      content,
      version,
      sentVersion: previous?.sentVersion ?? 0,
      used: Date.now(),
      pending: (previous?.pending ?? 0) + 1,
    });
    server.diagnostics.delete(uri);
    const sent = this.enqueue(server, async () => {
      try {
        await this.ensure(server);
        await this.sendDocument(server, path, content, version, true);
      } finally {
        const document = server.documents.get(uri);
        if (document) document.pending--;
      }
    });
    // Keep errors observable through the ticket while preventing abandoned tickets from rejecting globally.
    this.background(server, sent);
    return {
      result: async (signal) => {
        try {
          signal.throwIfAborted();
          await this.cancellable(sent, signal);
          return {
            diagnostics: await this.collectDiagnostics(
              server,
              uri,
              version,
              signal,
              this.limits.diagnosticsTimeoutMs,
              this.limits.maxEditDiagnostics,
            ),
          };
        } catch (error) {
          signal.throwIfAborted();
          return { diagnostics: { status: "unavailable", reason: message(error), items: [], truncated: false } };
        }
      },
    };
  }
  async diagnostics(input: string, signal: AbortSignal): Promise<FileDiagnostics> {
    const path = await this.path(input);
    const server = await this.prepare(path, signal);
    const uri = this.uri(path);
    return this.collectDiagnostics(
      server,
      uri,
      server.documents.get(uri)!.version,
      signal,
      this.limits.requestTimeoutMs,
      this.limits.maxDiagnostics,
    );
  }
  private async collectDiagnostics(
    server: ServerState,
    uri: string,
    version: number,
    signal: AbortSignal,
    timeout: number,
    maximum: number,
  ): Promise<FileDiagnostics> {
    if (server.documents.get(uri)?.version !== version)
      return { status: "pending", items: [], truncated: false, ...this.busy(server) };
    if (server.capabilities.diagnosticProvider) {
      const response = await this.request<{ kind: "full" | "unchanged"; items?: Diagnostic[] }>(
        server,
        "textDocument/diagnostic",
        { textDocument: { uri } },
        signal,
        timeout,
      );
      if (server.documents.get(uri)?.version !== version)
        return { status: "pending", items: [], truncated: false, ...this.busy(server) };
      if (response.kind !== "full" || !response.items)
        throw new LspProtocolError("Expected full diagnostic report without previousResultId");
      server.diagnostics.set(uri, {
        items: response.items,
        version,
        receivedAt: new Date().toISOString(),
        generation: server.generation,
      });
    } else {
      const ready = () => {
        const entry = server.diagnostics.get(uri);
        return (
          entry && entry.generation === server.generation && (entry.version === undefined || entry.version === version)
        );
      };
      if (!ready())
        await new Promise<void>((accept, reject) => {
          const finish = () => {
            clearTimeout(timer);
            server.waiters.delete(wake);
            signal.removeEventListener("abort", abort);
          };
          const wake = () => {
            if (server.state !== "running") {
              finish();
              reject(new LspServerExitedError(server.lastError));
            } else if (ready() || server.documents.get(uri)?.version !== version) {
              finish();
              accept();
            }
          };
          const abort = () => {
            finish();
            reject(signal.reason);
          };
          const timer = setTimeout(() => {
            finish();
            accept();
          }, timeout);
          server.waiters.add(wake);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
          else wake();
        });
    }
    const entry = server.diagnostics.get(uri);
    if (
      !entry ||
      server.documents.get(uri)?.version !== version ||
      (entry.version !== undefined && entry.version !== version)
    )
      return { status: "pending", items: [], truncated: false, ...this.busy(server) };
    const severities = ["error", "warning", "information", "hint"] as const;
    const items = entry.items
      .map((item) => ({
        line: item.range.start.line + 1,
        column: item.range.start.character + 1,
        endLine: item.range.end.line + 1,
        endColumn: item.range.end.character + 1,
        severity: severities[(item.severity ?? 1) - 1] ?? "error",
        message: (typeof item.message === "string" ? item.message : item.message.value).slice(0, 1000),
        ...(item.source ? { source: item.source } : {}),
        ...(item.code !== undefined ? { code: String(item.code) } : {}),
      }))
      .filter((item) => (this.options.diagnosticSeverities ?? ["error", "warning"]).includes(item.severity));
    return {
      status: entry.version === undefined ? "unknown" : "complete",
      receivedAt: entry.receivedAt,
      items: items.slice(0, maximum),
      truncated: items.length > maximum,
      ...this.busy(server),
    };
  }

  private async watched(server: ServerState, inputs: string[]): Promise<void> {
    const changes = await watchedChanges(server, inputs, {
      execution: this.options.execution,
      uri: (path) => this.uri(path),
      hostUri: (uri) => this.hostUri(uri),
    });
    await this.synchronize(server, new AbortController().signal);
    if (changes.length) await server.connection!.sendNotification("workspace/didChangeWatchedFiles", { changes });
  }

  async planRename(input: SymbolPosition, newName: string, signal: AbortSignal): Promise<RenamePlan> {
    if (!newName) throw new TypeError("newName must not be empty");
    const { server, params } = await this.position(input, signal);
    this.supports(server, "renameProvider", "textDocument/rename");
    if (typeof server.capabilities.renameProvider === "object" && server.capabilities.renameProvider.prepareProvider) {
      try {
        if (
          (await this.request(
            server,
            "textDocument/prepareRename",
            params,
            signal,
            this.limits.requestTimeoutMs,
            false,
          )) === null
        )
          throw new Error("This position cannot be renamed");
      } catch (error) {
        if (error instanceof ResponseError && error.code !== -32801 && error.code !== -32802)
          throw new Error(`This position cannot be renamed: ${error.message}`, { cause: error });
        throw error;
      }
    }
    const edit = await this.request<WorkspaceEdit | null>(
      server,
      "textDocument/rename",
      { ...params, newName },
      signal,
      this.limits.requestTimeoutMs,
      false,
    );
    if (!edit) throw new Error("This position cannot be renamed");
    return this.renames.plan(edit, {
      newName,
      signal,
      maxFileBytes: this.limits.maxFileBytes,
      documents: server.documents,
      hostUri: (uri) => this.hostUri(uri),
      select: (path) => this.select(path),
    });
  }
  cacheRename(toolCallId: string, input: SymbolPosition & { readonly newName: string }, plan: RenamePlan): void {
    this.renames.cache(toolCallId, input, plan);
  }
  takeRename(toolCallId: string, input: SymbolPosition & { readonly newName: string }): RenamePlan | undefined {
    return this.renames.take(toolCallId, input);
  }
  async executeRename(plan: RenamePlan, signal: AbortSignal, guard = this.options.guard): Promise<RenameOutput> {
    return this.renames.execute(plan, {
      signal,
      guard,
      record: (path, content) => this.record(path, content),
    });
  }

  private async stop(server: ServerState): Promise<void> {
    const child = server.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    server.stopping = true;
    try {
      await this.request(server, "shutdown", null, new AbortController().signal, this.limits.shutdownTimeoutMs, false);
    } catch (error) {
      server.lastError = message(error);
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        await server.connection?.sendNotification("exit");
      } catch (error) {
        server.lastError = message(error);
      }
      await new Promise<void>((accept) => {
        const timer = setTimeout(() => {
          child.removeListener("exit", exited);
          accept();
        }, 2000);
        const exited = () => {
          clearTimeout(timer);
          accept();
        };
        child.once("exit", exited);
      });
    }
    if (child.exitCode === null && child.signalCode === null) {
      server.controller?.abort();
      await new Promise<void>((accept) => {
        if (child.exitCode !== null || child.signalCode !== null) accept();
        else child.once("exit", () => accept());
      });
    }
    server.connection?.dispose();
    server.state = "stopped";
  }
  async restart(serverId: string): Promise<void> {
    const server = this.servers.get(serverId);
    if (!server) throw new Error(`No configured server ${serverId}`);
    if (server.starting) await server.starting.catch(() => {});
    await this.stop(server);
    server.exits = 0;
    server.state = "stopped";
    delete server.lastError;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    if (this.watchTimer) clearTimeout(this.watchTimer);
    await this.renames.settled();
    await this.lifecycle;
    await Promise.all(
      [...this.servers.values()].map(async (server) => {
        await server.sync;
        await this.stop(server);
      }),
    );
    this.renames.clear();
  }
}

/** @experimental */
export async function openLanguageServerManager(options: LanguageServerManagerOptions): Promise<LanguageServerManager> {
  const manager = new Manager(options);
  await manager.open();
  return manager;
}
