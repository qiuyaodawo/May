import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { syncDirectory } from "./file-ownership.js";
import { join, resolve } from "node:path";

export interface SessionSummary {
  readonly id: string;
  readonly workspace: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly title?: string;
  readonly preview?: string;
  readonly turnCount?: number;
}

export interface SessionCatalog {
  list(workspace: string): Promise<readonly SessionSummary[]>;
  record(summary: SessionSummary): Promise<void>;
  rename?(sessionId: string, workspace: string, title: string): Promise<boolean>;
  remove?(sessionId: string, workspace: string): Promise<boolean>;
}

export class InMemorySessionCatalog implements SessionCatalog {
  private readonly sessions = new Map<string, SessionSummary>();

  async list(workspace: string): Promise<readonly SessionSummary[]> {
    return sortSessions(
      [...this.sessions.values()].filter((item) =>
        sameWorkspace(item.workspace, workspace)
      ),
    );
  }

  async record(summary: SessionSummary): Promise<void> {
    const current = this.sessions.get(summary.id);
    this.sessions.set(summary.id, mergeSummary(current, summary));
  }

  async rename(
    sessionId: string,
    workspace: string,
    title: string,
  ): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (current === undefined || !sameWorkspace(current.workspace, workspace)) {
      return false;
    }
    this.sessions.set(sessionId, { ...current, title });
    return true;
  }

  async remove(sessionId: string, workspace: string): Promise<boolean> {
    const current = this.sessions.get(sessionId);
    if (current === undefined || !sameWorkspace(current.workspace, workspace)) {
      return false;
    }
    return this.sessions.delete(sessionId);
  }
}

/**
 * A process-safe, append-only session catalog backed by atomic operation files.
 *
 * The legacy JSON snapshot at `path` is treated as a base snapshot. Updates are
 * committed under `${path}.operations` and replayed in filename order, so
 * independent catalog instances do not overwrite one another's changes.
 */
export class FileSessionCatalog implements SessionCatalog {
  readonly path: string;

  private tail: Promise<void> = Promise.resolve();
  private readonly operationsDirectory: string;
  private operationClock = 0;

  /** Offline maintenance: stop other catalog users before compacting operation files. */
  compact(options: { readonly confirmHostsStopped: true }): Promise<void> {
    if (options.confirmHostsStopped !== true) return Promise.reject(new Error("Catalog compaction requires stopped hosts"));
    return this.enqueue(async () => {
      const sessions = await this.readNow();
      const names = await readdir(this.operationsDirectory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      const absorbed = names.filter((name) => name.endsWith(".json"));
      if (absorbed.length === 0) return;
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ version: 2, sessions, absorbed })); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, this.path);
        await syncDirectory(resolve(this.path, ".."));
        // The snapshot records exact absorbed names, so a crash during cleanup is replay-safe.
        for (const name of absorbed) await rm(join(this.operationsDirectory, name), { force: true });
      } finally { await rm(temporary, { force: true }); }
    });
  }

  constructor(path: string) {
    this.path = resolve(path);
    this.operationsDirectory = `${this.path}.operations`;
  }

  async list(workspace: string): Promise<readonly SessionSummary[]> {
    await this.tail;
    return sortSessions(
      (await this.readNow()).filter((item) =>
        sameWorkspace(item.workspace, workspace)
      ),
    );
  }

  record(summary: SessionSummary): Promise<void> {
    return this.enqueue(async () => {
      await this.appendOperation({ type: "record", summary: { ...summary } });
    });
  }

  rename(
    sessionId: string,
    workspace: string,
    title: string,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      const exists = (await this.readNow()).some((item) =>
        item.id === sessionId && sameWorkspace(item.workspace, workspace)
      );
      if (!exists) return false;
      await this.appendOperation({ type: "rename", sessionId, workspace, title });
      return true;
    });
  }

  remove(sessionId: string, workspace: string): Promise<boolean> {
    return this.enqueue(async () => {
      const exists = (await this.readNow()).some((item) =>
        item.id === sessionId && sameWorkspace(item.workspace, workspace)
      );
      if (!exists) return false;
      await this.appendOperation({ type: "remove", sessionId, workspace });
      return true;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readNow(): Promise<SessionSummary[]> {
    const snapshot = await this.readLegacyCatalog();
    const sessions = new Map(snapshot.sessions.map((summary) => [summary.id, summary]));
    for (const operation of await this.readOperations(new Set(snapshot.absorbed))) {
      if (operation.type === "record") {
        sessions.set(
          operation.summary.id,
          mergeSummary(sessions.get(operation.summary.id), operation.summary),
        );
        continue;
      }
      const current = sessions.get(operation.sessionId);
      if (
        current === undefined ||
        !sameWorkspace(current.workspace, operation.workspace)
      ) {
        continue;
      }
      if (operation.type === "rename") {
        sessions.set(operation.sessionId, { ...current, title: operation.title });
      } else {
        sessions.delete(operation.sessionId);
      }
    }
    return [...sessions.values()];
  }

  private async readLegacyCatalog(): Promise<{ sessions: SessionSummary[]; absorbed: string[] }> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { sessions: [], absorbed: [] };
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error(`Invalid May session catalog JSON: ${this.path}`);
    }
    if (
      typeof value !== "object" || value === null ||
      !("version" in value) || (value.version !== 1 && value.version !== 2) ||
      !("sessions" in value) || !Array.isArray(value.sessions) ||
      !value.sessions.every(isSessionSummary)
    ) {
      throw new Error(`Invalid May session catalog: ${this.path}`);
    }
    const absorbed = value.version === 2 && "absorbed" in value ? value.absorbed : [];
    if (!Array.isArray(absorbed) || absorbed.some((name) => typeof name !== "string" || !/^[\w.-]+\.json$/u.test(name))) throw new Error(`Invalid May session catalog checkpoint: ${this.path}`);
    return { sessions: value.sessions.map((item) => ({ ...item })), absorbed };
  }

  private async readOperations(absorbed = new Set<string>()): Promise<CatalogOperation[]> {
    let names: string[];
    try {
      names = (await readdir(this.operationsDirectory))
        .filter((name) => name.endsWith(".json") && !absorbed.has(name))
        .sort();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }
    const operations: CatalogOperation[] = [];
    for (const name of names) {
      const path = join(this.operationsDirectory, name);
      let value: unknown;
      try {
        value = JSON.parse(await readFile(path, "utf8"));
      } catch (error) {
        throw new Error(`Invalid May session catalog operation: ${path}`, {
          cause: error,
        });
      }
      if (!isCatalogOperation(value)) {
        throw new Error(`Invalid May session catalog operation: ${path}`);
      }
      operations.push(value);
    }
    return operations;
  }

  private async appendOperation(operation: CatalogOperation): Promise<void> {
    await mkdir(this.operationsDirectory, { recursive: true });
    const token = randomUUID();
    const temporary = join(
      this.operationsDirectory,
      `.${process.pid}-${token}.tmp`,
    );
    try {
      await writeFile(temporary, `${JSON.stringify(operation)}\n`, "utf8");
      const timestamp = await this.nextOperationTimestamp();
      await rename(
        temporary,
        join(
          this.operationsDirectory,
          `${String(timestamp).padStart(16, "0")}-${process.pid}-${token}.json`,
        ),
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async nextOperationTimestamp(): Promise<number> {
    const names = await readdir(this.operationsDirectory);
    const latest = names.reduce((maximum, name) => {
      const value = Number(name.slice(0, 16));
      return Number.isSafeInteger(value) ? Math.max(maximum, value) : maximum;
    }, 0);
    const timestamp = Math.max(Date.now(), this.operationClock + 1, latest + 1);
    this.operationClock = timestamp;
    return timestamp;
  }
}

type CatalogOperation =
  | { readonly type: "record"; readonly summary: SessionSummary }
  | {
      readonly type: "rename";
      readonly sessionId: string;
      readonly workspace: string;
      readonly title: string;
    }
  | {
      readonly type: "remove";
      readonly sessionId: string;
      readonly workspace: string;
    };

function isCatalogOperation(value: unknown): value is CatalogOperation {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  if (value.type === "record") {
    return "summary" in value && isSessionSummary(value.summary);
  }
  if (value.type !== "rename" && value.type !== "remove") return false;
  if (
    !("sessionId" in value) || typeof value.sessionId !== "string" ||
    value.sessionId === "" || !("workspace" in value) ||
    typeof value.workspace !== "string" || value.workspace === ""
  ) {
    return false;
  }
  return value.type === "remove" ||
    ("title" in value && typeof value.title === "string" && value.title !== "");
}

export async function latestSession(
  catalog: SessionCatalog,
  workspace: string,
): Promise<SessionSummary | undefined> {
  return (await catalog.list(workspace))[0];
}

function mergeSummary(
  current: SessionSummary | undefined,
  update: SessionSummary,
): SessionSummary {
  const title = current?.title ?? update.title;
  const preview = update.preview ?? current?.preview;
  const turnCount = update.turnCount ?? current?.turnCount;
  return {
    ...update,
    createdAt: current?.createdAt ?? update.createdAt,
    ...(title === undefined ? {} : { title }),
    ...(preview === undefined ? {} : { preview }),
    ...(turnCount === undefined ? {} : { turnCount }),
  };
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return sessions.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
}

function sameWorkspace(left: string, right: string): boolean {
  return normalizeWorkspace(left) === normalizeWorkspace(right);
}

function normalizeWorkspace(workspace: string): string {
  const path = resolve(workspace);
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isSessionSummary(value: unknown): value is SessionSummary {
  return typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id !== "" &&
    "workspace" in value &&
    typeof value.workspace === "string" &&
    value.workspace !== "" &&
    "createdAt" in value &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    "lastUsedAt" in value &&
    typeof value.lastUsedAt === "number" &&
    Number.isFinite(value.lastUsedAt) &&
    (!("title" in value) ||
      (typeof value.title === "string" && value.title.trim() !== "")) &&
    (!("preview" in value) || typeof value.preview === "string") &&
    (!("turnCount" in value) ||
      (Number.isSafeInteger(value.turnCount) &&
        typeof value.turnCount === "number" && value.turnCount >= 0));
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
