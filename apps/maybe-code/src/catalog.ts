import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface SessionSummary {
  readonly id: string;
  readonly workspace: string;
  readonly createdAt: number;
  readonly lastUsedAt: number;
}

export interface SessionCatalog {
  list(workspace: string): Promise<readonly SessionSummary[]>;
  record(summary: SessionSummary): Promise<void>;
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
}

export class FileSessionCatalog implements SessionCatalog {
  readonly path: string;

  private tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = resolve(path);
  }

  async list(workspace: string): Promise<readonly SessionSummary[]> {
    await this.tail;
    return sortSessions(
      (await this.read()).filter((item) =>
        sameWorkspace(item.workspace, workspace)
      ),
    );
  }

  record(summary: SessionSummary): Promise<void> {
    const operation = this.tail.then(async () => {
      const sessions = await this.read();
      const index = sessions.findIndex((item) => item.id === summary.id);
      if (index === -1) {
        sessions.push({ ...summary });
      } else {
        sessions[index] = mergeSummary(sessions[index], summary);
      }
      await this.write(sessions);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async read(): Promise<SessionSummary[]> {
    let source: string;
    try {
      source = await readFile(this.path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error(`Invalid MaybeCode session catalog JSON: ${this.path}`);
    }
    if (
      typeof value !== "object" ||
      value === null ||
      !("version" in value) ||
      value.version !== 1 ||
      !("sessions" in value) ||
      !Array.isArray(value.sessions) ||
      !value.sessions.every(isSessionSummary)
    ) {
      throw new Error(`Invalid MaybeCode session catalog: ${this.path}`);
    }
    return value.sessions.map((item) => ({ ...item }));
  }

  private async write(sessions: readonly SessionSummary[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, sessions }, undefined, 2)}\n`,
        "utf8",
      );
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
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
  return {
    ...update,
    createdAt: current?.createdAt ?? update.createdAt,
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
    Number.isFinite(value.lastUsedAt);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
