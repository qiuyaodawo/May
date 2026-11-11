import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  createProtocolConnection,
  type ProtocolConnection,
  type ServerCapabilities,
  type Diagnostic,
  type Location,
  type LocationLink,
  type Range,
  type TextEdit,
  type WorkspaceEdit,
  type DocumentSymbol,
  type SymbolInformation,
  type WorkspaceSymbol,
  type Hover,
  type FileSystemWatcher,
} from "vscode-languageserver-protocol/node";
import {
  CancellationTokenSource,
  StreamMessageReader,
  StreamMessageWriter,
  ResponseError,
  Trace,
} from "vscode-jsonrpc/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { URI } from "vscode-uri";
import picomatch from "picomatch";
import { z } from "zod";
import {
  atomicWriteText,
  createReadTool,
  resolveExistingWorkspacePath,
  workspaceFileKey,
  type WorkspacePath,
  type WorkspaceFileFeedback,
  type WorkspaceFileFeedbackTicket,
  type WorkspaceFileGuard,
} from "@sortedyuan/coding-tools";
import { writeFileDurable } from "@sortedyuan/may/storage";
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
import {
  LspProtocolError,
  LspRenameConflictError,
  LspRenameWriteError,
  LspServerExitedError,
  LspTimeoutError,
} from "./errors.js";
import { resolveServerCommand, serverDefinition } from "./presets.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const journalSchema = z.object({
  files: z.array(z.object({ path: z.string(), original: z.string(), updatedHash: z.string() })),
});
interface DocumentState {
  path: WorkspacePath;
  content: string;
  version: number;
  sentVersion: number;
  used: number;
  pending: number;
}
interface DiagnosticState {
  version?: number;
  items: Diagnostic[];
  receivedAt: string;
  generation: number;
}
interface ServerState {
  definition: ReturnType<typeof serverDefinition>;
  state: LanguageServerStatus["state"];
  connection?: ProtocolConnection;
  child?: ChildProcess;
  controller?: AbortController;
  starting?: Promise<void>;
  capabilities: ServerCapabilities;
  documents: Map<string, DocumentState>;
  diagnostics: Map<string, DiagnosticState>;
  waiters: Set<() => void>;
  progress: Map<string | number, string>;
  watchers: Map<string, FileSystemWatcher[]>;
  knownFiles: Set<string>;
  sync: Promise<void>;
  exits: number;
  startedAt: number;
  used: number;
  generation: number;
  stopping: boolean;
  stderr: string;
  logs: string;
  lastError?: string;
  resolved?: { command: string; args: readonly string[] };
}

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
  private readonly journal: string;
  private readonly plans = new Map<string, { input: string; plan: RenamePlan }>();
  private readonly ownedPlans = new WeakSet<RenamePlan>();
  private readonly usedPlans = new WeakSet<RenamePlan>();
  private watcher: FSWatcher | undefined;
  private watchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly changes = new Set<string>();
  private closed = false;
  private recovery: string | undefined;
  private transaction: Promise<unknown> = Promise.resolve();
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
    this.journal = join(options.dataDirectory, "lsp-rename", `${hash(options.execution.workspace)}.json`);
    for (const input of options.servers) {
      const definition = serverDefinition(input);
      if (this.servers.has(definition.id)) throw new TypeError(`Duplicate server ${definition.id}`);
      const server: ServerState = {
        definition,
        state: "stopped",
        capabilities: {},
        documents: new Map(),
        diagnostics: new Map(),
        waiters: new Set(),
        progress: new Map(),
        watchers: new Map(),
        knownFiles: new Set(),
        sync: Promise.resolve(),
        exits: 0,
        startedAt: 0,
        used: 0,
        generation: 0,
        stopping: false,
        stderr: "",
        logs: "",
      };
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
    await mkdir(dirname(this.journal), { recursive: true });
    if ((await readdir(dirname(this.journal))).includes(this.journal.split(/[\\/]/u).at(-1)!)) {
      const journal = journalSchema.parse(JSON.parse(await readFile(this.journal, "utf8")));
      const recovered: string[] = [];
      for (const file of journal.files) {
        const path = await this.path(file.path);
        const content = await this.read(path, new AbortController().signal);
        if (hash(content) === file.updatedHash) {
          await atomicWriteText(path.absolute, file.original, new AbortController().signal);
          recovered.push(path.relative);
        }
      }
      await rm(this.journal);
      this.recovery = `Recovered rename transaction: ${recovered.join(", ")}`;
    }
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
        server.stderr = this.tail(server.stderr + data.toString());
      });
      const connection = createProtocolConnection(
        new StreamMessageReader(child.stdout!),
        new StreamMessageWriter(child.stdin!),
      );
      server.connection = connection;
      await connection.trace(Trace.Messages, {
        log: (entry: string) => {
          server.logs = this.tail(server.logs + entry + "\n");
        },
      });
      const folder = {
        uri: this.uri({ absolute: this.options.execution.workspace, relative: "." }),
        name: "workspace",
      };
      connection.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
        params.items.map((item) => {
          let value: unknown = server.definition.settings ?? {};
          for (const part of item.section?.split(".") ?? [])
            value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[part] : undefined;
          return value ?? null;
        }),
      );
      connection.onRequest("workspace/workspaceFolders", () => [folder]);
      connection.onRequest("workspace/applyEdit", () => ({
        applied: false,
        failureReason: "Use lsp_rename to modify workspace files",
      }));
      connection.onRequest("window/showMessageRequest", () => null);
      connection.onRequest("window/workDoneProgress/create", () => null);
      connection.onRequest(
        "client/registerCapability",
        async (params: {
          registrations: { id: string; method: string; registerOptions?: { watchers?: FileSystemWatcher[] } }[];
        }) => {
          if (
            params.registrations.some((registration) => registration.method === "workspace/didChangeWatchedFiles") &&
            !server.watchers.size
          ) {
            const entries = await readdir(this.options.execution.workspace, { recursive: true, withFileTypes: true });
            for (const entry of entries) if (entry.isFile()) server.knownFiles.add(join(entry.parentPath, entry.name));
          }
          for (const registration of params.registrations)
            if (registration.method === "workspace/didChangeWatchedFiles")
              server.watchers.set(registration.id, registration.registerOptions?.watchers ?? []);
          return null;
        },
      );
      connection.onRequest(
        "client/unregisterCapability",
        (params: { unregisterations?: { id: string }[]; unregistrations?: { id: string }[] }) => {
          for (const registration of params.unregisterations ?? params.unregistrations ?? [])
            server.watchers.delete(registration.id);
          return null;
        },
      );
      for (const method of [
        "workspace/diagnostic/refresh",
        "workspace/semanticTokens/refresh",
        "workspace/inlayHint/refresh",
        "workspace/codeLens/refresh",
        "workspace/inlineValue/refresh",
        "workspace/foldingRange/refresh",
      ])
        connection.onRequest(method, () => {
          server.diagnostics.clear();
          return null;
        });
      connection.onNotification(
        "textDocument/publishDiagnostics",
        (params: { uri: string; version?: number; diagnostics: Diagnostic[] }) => {
          const document = server.documents.get(params.uri);
          if (params.version !== undefined && document && params.version < document.version) return;
          server.diagnostics.set(params.uri, {
            ...(params.version === undefined ? {} : { version: params.version }),
            items: params.diagnostics,
            receivedAt: new Date().toISOString(),
            generation: server.generation,
          });
          for (const wake of server.waiters) wake();
        },
      );
      connection.onNotification(
        "$/progress",
        (params: { token: string | number; value: { kind?: string; title?: string } }) => {
          if (params.value.kind === "end") server.progress.delete(params.token);
          else if (params.value.title) server.progress.set(params.token, params.value.title);
        },
      );
      for (const method of ["window/logMessage", "window/showMessage"])
        connection.onNotification(method, (params: { message: string }) => {
          server.logs = this.tail(server.logs + params.message + "\n");
        });
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
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            textDocument: {
              synchronization: { didSave: true },
              publishDiagnostics: { versionSupport: true },
              diagnostic: {},
              definition: { linkSupport: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              rename: { prepareSupport: true },
              documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            },
            workspace: {
              workspaceFolders: true,
              configuration: true,
              didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true },
              workspaceEdit: { documentChanges: true, resourceOperations: [] },
              applyEdit: false,
              symbol: {},
            },
            window: { workDoneProgress: true },
          },
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

  private tail(text: string): string {
    return Buffer.from(text).subarray(-65536).toString("utf8");
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
    if (document.sentVersion !== version)
      server.logs = this.tail(server.logs + `Document sync ${uri} version ${version}\n`);
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
    const changes: { uri: string; type: number }[] = [];
    for (const input of inputs) {
      const absolute = join(this.options.execution.workspace, input);
      const uri = this.uri({ absolute, relative: input });
      const exists = await stat(absolute).then(
        (info) => info.isFile(),
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
      for (const watchers of server.watchers.values()) {
        for (const watcher of watchers) {
          const pattern = watcher.globPattern;
          const base =
            typeof pattern === "string"
              ? this.options.execution.workspace
              : this.hostUri(typeof pattern.baseUri === "string" ? pattern.baseUri : pattern.baseUri.uri).host;
          if (!base) continue;
          const glob = (typeof pattern === "string" ? pattern : pattern.pattern).replace(/\\/gu, "/");
          const candidate =
            typeof pattern === "string" && (/^\//u.test(glob) || /^[a-z]:\//iu.test(glob))
              ? this.options.execution.toEnvironmentPath(absolute).replace(/\\/gu, "/")
              : relative(base, absolute).replace(/\\/gu, "/");
          if (picomatch(glob, { dot: true })(candidate)) {
            const type = exists ? (server.knownFiles.has(absolute) ? 2 : 1) : 3;
            if ((watcher.kind ?? 7) & (type === 1 ? 1 : type === 2 ? 2 : 4)) changes.push({ uri, type });
          }
        }
      }
      if (exists) server.knownFiles.add(absolute);
      else server.knownFiles.delete(absolute);
    }
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
    if (edit.changes && edit.documentChanges)
      throw new LspProtocolError("Rename response contains both changes and documentChanges");
    const grouped = new Map<string, { edits: TextEdit[]; version: number | null }>();
    for (const [uri, edits] of Object.entries(edit.changes ?? {})) grouped.set(uri, { edits, version: null });
    for (const change of edit.documentChanges ?? []) {
      if (!("textDocument" in change)) throw new LspProtocolError("Rename resource operations are not supported");
      if (grouped.has(change.textDocument.uri)) throw new LspProtocolError("Duplicate rename document");
      const edits: TextEdit[] = change.edits.map((entry) => {
        if (!("newText" in entry)) throw new LspProtocolError("Rename snippet edits are not supported");
        return entry;
      });
      grouped.set(change.textDocument.uri, { edits, version: change.textDocument.version });
    }
    if (grouped.size > 100 || [...grouped.values()].reduce((total, file) => total + file.edits.length, 0) > 5000)
      throw new LspProtocolError("Rename exceeds 100 files or 5000 edits");
    const files: RenamePlan["files"][number][] = [];
    const keys = new Set<string>();
    for (const [uri, change] of grouped) {
      const mapped = this.hostUri(uri);
      if (!mapped.host) throw new LspProtocolError(`Rename outside workspace: ${mapped.environmentPath}`);
      const path = await this.path(mapped.host);
      const key = workspaceFileKey(path);
      if (keys.has(key)) throw new LspProtocolError(`Duplicate rename file ${path.relative}`);
      keys.add(key);
      if (change.version !== null && change.version !== server.documents.get(uri)?.sentVersion)
        throw new LspRenameConflictError(`Document version changed: ${path.relative}`);
      const original = await this.read(path, signal);
      const document = TextDocument.create(uri, this.select(path).language, change.version ?? 0, original);
      const ordered = [...change.edits].sort(
        (a, b) => document.offsetAt(a.range.start) - document.offsetAt(b.range.start),
      );
      let previousEnd = -1;
      for (const textEdit of ordered) {
        const start = document.offsetAt(textEdit.range.start);
        const end = document.offsetAt(textEdit.range.end);
        const actualStart = document.positionAt(start);
        const actualEnd = document.positionAt(end);
        if (
          start < previousEnd ||
          end < start ||
          actualStart.line !== textEdit.range.start.line ||
          actualStart.character !== textEdit.range.start.character ||
          actualEnd.line !== textEdit.range.end.line ||
          actualEnd.character !== textEdit.range.end.character
        )
          throw new LspProtocolError(`Invalid or overlapping rename edits: ${path.relative}`);
        previousEnd = end;
      }
      const updated = TextDocument.applyEdits(document, change.edits);
      if (Buffer.byteLength(updated) > this.limits.maxFileBytes)
        throw new LspProtocolError(`Renamed file exceeds maxFileBytes: ${path.relative}`);
      files.push({
        path,
        original,
        updated,
        originalHash: hash(original),
        updatedHash: hash(updated),
        edits: change.edits,
      });
    }
    const plan = Object.freeze({
      files: Object.freeze(
        files.map((file) =>
          Object.freeze({
            ...file,
            path: Object.freeze(file.path),
            edits: Object.freeze(
              file.edits.map((edit) =>
                Object.freeze({
                  ...edit,
                  range: Object.freeze({ start: Object.freeze(edit.range.start), end: Object.freeze(edit.range.end) }),
                }),
              ),
            ),
          }),
        ),
      ),
      newName,
    });
    this.ownedPlans.add(plan);
    return plan;
  }
  cacheRename(toolCallId: string, input: SymbolPosition & { readonly newName: string }, plan: RenamePlan): void {
    if (!this.ownedPlans.has(plan)) throw new TypeError("Rename plan belongs to another manager");
    this.plans.set(toolCallId, { input: JSON.stringify(input), plan });
    if (this.plans.size > 100) this.plans.delete(this.plans.keys().next().value!);
  }
  takeRename(toolCallId: string, input: SymbolPosition & { readonly newName: string }): RenamePlan | undefined {
    const cached = this.plans.get(toolCallId);
    this.plans.delete(toolCallId);
    if (cached && cached.input !== JSON.stringify(input))
      throw new LspRenameConflictError("Rename input changed after preview");
    return cached?.plan;
  }
  async executeRename(plan: RenamePlan, signal: AbortSignal, guard = this.options.guard): Promise<RenameOutput> {
    if (!this.ownedPlans.has(plan) || this.usedPlans.has(plan))
      throw new TypeError("Invalid or already executed rename plan");
    const operation = async () => {
      signal.throwIfAborted();
      const paths = await Promise.all(plan.files.map((file) => this.path(file.path.relative)));
      const tickets: { path: string; ticket: WorkspaceFileFeedbackTicket }[] = [];
      const write = async () => {
        for (const [index, file] of plan.files.entries())
          if (
            workspaceFileKey(paths[index]!) !== workspaceFileKey(file.path) ||
            hash(await this.read(paths[index]!, signal)) !== file.originalHash
          )
            throw new LspRenameConflictError(`File changed after rename preview: ${file.path.relative}`);
        await writeFileDurable(
          this.journal,
          JSON.stringify({
            files: plan.files.map((file) => ({
              path: file.path.relative,
              original: file.original,
              updatedHash: file.updatedHash,
            })),
          }),
        );
        const written: (typeof plan.files)[number][] = [];
        let failedPath = "";
        try {
          for (const file of plan.files) {
            failedPath = file.path.relative;
            await atomicWriteText(file.path.absolute, file.updated, signal);
            written.push(file);
          }
        } catch (error) {
          const restored: string[] = [];
          const errors: string[] = [];
          for (const file of written.reverse()) {
            try {
              await atomicWriteText(file.path.absolute, file.original, new AbortController().signal);
              restored.push(file.path.relative);
            } catch (restoreError) {
              errors.push(`${file.path.relative}: ${message(restoreError)}`);
            }
          }
          if (!errors.length) await rm(this.journal);
          throw new LspRenameWriteError(
            `Rename failed at ${failedPath}: ${message(error)}. Restored: ${restored.join(", ")}. Recovery errors: ${errors.join(", ")}`,
            { cause: error },
          );
        }
        await rm(this.journal);
        this.usedPlans.add(plan);
        for (const file of plan.files) {
          const ticket = this.record(file.path, file.updated);
          if (ticket) tickets.push({ path: file.path.relative, ticket });
        }
      };
      if (guard) await guard.runMany(paths, "lsp_rename", write);
      else await write();
      const diagnostics: Record<string, FileDiagnostics> = {};
      await Promise.all(
        tickets.map(async ({ path, ticket }) => {
          diagnostics[path] = (await ticket.result(signal)).diagnostics;
        }),
      );
      return { files: plan.files.map((file) => ({ path: file.path.relative, edits: file.edits.length })), diagnostics };
    };
    const result = this.transaction.then(operation);
    this.transaction = result.then(
      () => {},
      () => {},
    );
    return result;
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
    await this.transaction;
    await this.lifecycle;
    await Promise.all(
      [...this.servers.values()].map(async (server) => {
        await server.sync;
        await this.stop(server);
      }),
    );
    this.plans.clear();
  }
}

/** @experimental */
export async function openLanguageServerManager(options: LanguageServerManagerOptions): Promise<LanguageServerManager> {
  const manager = new Manager(options);
  await manager.open();
  return manager;
}
