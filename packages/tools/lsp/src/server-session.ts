import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ChildProcess } from "node:child_process";
import type {
  ProtocolConnection,
  ServerCapabilities,
  Diagnostic,
  FileSystemWatcher,
} from "vscode-languageserver-protocol/node";
import picomatch from "picomatch";
import type { CodingExecutionEnvironment, WorkspacePath } from "@sortedyuan/coding-tools";
import type { LanguageServerStatus } from "./types.js";
import type { serverDefinition } from "./presets.js";
import { tail } from "./text.js";

export interface DocumentState {
  path: WorkspacePath;
  content: string;
  version: number;
  sentVersion: number;
  used: number;
  pending: number;
}
export interface DiagnosticState {
  version?: number;
  items: Diagnostic[];
  receivedAt: string;
  generation: number;
}
export interface ServerState {
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
export interface WatchedPaths {
  readonly execution: CodingExecutionEnvironment;
  uri(path: WorkspacePath): string;
  hostUri(uri: string): { host?: string; environmentPath: string };
}

export const CLIENT_CAPABILITIES = {
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
};

export function createServerState(definition: ReturnType<typeof serverDefinition>): ServerState {
  return {
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
}

export function registerClientHandlers(
  connection: ProtocolConnection,
  server: ServerState,
  workspace: string,
  folder: { uri: string; name: string },
): void {
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
        const entries = await readdir(workspace, { recursive: true, withFileTypes: true });
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
      server.logs = tail(server.logs + params.message + "\n");
    });
}

export async function watchedChanges(
  server: ServerState,
  inputs: string[],
  paths: WatchedPaths,
): Promise<{ uri: string; type: number }[]> {
  const changes: { uri: string; type: number }[] = [];
  for (const input of inputs) {
    const absolute = join(paths.execution.workspace, input);
    const uri = paths.uri({ absolute, relative: input });
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
            ? paths.execution.workspace
            : paths.hostUri(typeof pattern.baseUri === "string" ? pattern.baseUri : pattern.baseUri.uri).host;
        if (!base) continue;
        const glob = (typeof pattern === "string" ? pattern : pattern.pattern).replace(/\\/gu, "/");
        const candidate =
          typeof pattern === "string" && (/^\//u.test(glob) || /^[a-z]:\//iu.test(glob))
            ? paths.execution.toEnvironmentPath(absolute).replace(/\\/gu, "/")
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
  return changes;
}
