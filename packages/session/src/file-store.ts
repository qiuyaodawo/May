import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { SessionEvent } from "./events.js";
import { syncDirectory } from "./file-ownership.js";
export { acquireFileLock, recoverFileLock, releaseFileLock, syncDirectory, replaceJournalFile } from "./file-ownership.js";
import {
  type SessionStore,
  validateSessionHistory,
} from "./store.js";

export class FileSessionStore implements SessionStore {
  readonly directory: string;

  private readonly validated = new Map<string, { seq: number; size: number; mtimeMs: number; ctimeMs: number; ino: number }>();
  private readonly tails = new Map<string, Promise<void>>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  append(event: SessionEvent): Promise<void> {
    return this.enqueue(event.sessionId, () => this.appendNow(event));
  }

  private enqueue<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(action);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(sessionId) === tail) {
        this.tails.delete(sessionId);
      }
    });
    return operation;
  }

  read(sessionId: string): Promise<readonly SessionEvent[]> {
    return this.enqueue(sessionId, () => this.readNow(sessionId));
  }

  delete(sessionId: string): Promise<boolean> {
    return this.enqueue(sessionId, async () => {
      try {
        await rm(this.filePath(sessionId));
        this.validated.delete(sessionId);
        return true;
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return false;
        throw error;
      }
    });
  }

  private async appendNow(event: SessionEvent): Promise<void> {
    const cached = this.validated.get(event.sessionId);
    const info = cached === undefined ? undefined : await stat(this.filePath(event.sessionId)).catch(() => undefined);
    const unchanged = cached !== undefined && info !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs && cached.ino === info.ino;
    const expectedSeq = (unchanged ? cached.seq : (await this.readNow(event.sessionId)).length) + 1;

    if (event.seq !== expectedSeq) {
      throw new Error(
        `Expected session event sequence ${expectedSeq}, received ${event.seq}`,
      );
    }

    await mkdir(this.directory, { recursive: true });
    const file = await open(this.filePath(event.sessionId), "a");
    try {
      await file.writeFile(`${JSON.stringify(event)}\n`, "utf8");
      await file.sync();
      if (expectedSeq === 1) await syncDirectory(this.directory);
      const info = await file.stat();
      if (this.validated.size >= 256) this.validated.delete(this.validated.keys().next().value!);
      this.validated.set(event.sessionId, { seq: expectedSeq, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, ino: info.ino });
    } finally { await file.close(); }
  }

  private async readNow(sessionId: string): Promise<readonly SessionEvent[]> {
    const path = this.filePath(sessionId);
    let contents: string;

    try {
      const bytes = await readFile(path);
      // Newline terminates a committed record. Repair only an incomplete tail;
      // malformed complete records still fail closed. Requires one writer.
      const length = bytes.length === 0 || bytes.at(-1) === 10
        ? bytes.length : bytes.lastIndexOf(10) + 1;
      if (length !== bytes.length) {
        const file = await open(path, "r+");
        try { await file.truncate(length); await file.sync(); }
        finally { await file.close(); }
      }
      contents = bytes.subarray(0, length).toString("utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return [];
      throw error;
    }

    const events = contents
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line, index) => parseEvent(line, path, index + 1));
    validateSessionHistory(sessionId, events);
    return events;
  }

  private filePath(sessionId: string): string {
    const name = Buffer.from(sessionId, "utf8").toString("base64url");
    return join(this.directory, `${name}.jsonl`);
  }
}

function parseEvent(line: string, path: string, lineNumber: number): SessionEvent {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Invalid session event JSON at ${path}:${lineNumber}`);
  }

  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string" ||
    !("sessionId" in value) ||
    typeof value.sessionId !== "string" ||
    !("seq" in value) ||
    !Number.isSafeInteger(value.seq) || Number(value.seq) < 1 ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp) ||
    !validPayload(value as Record<string, unknown>)
  ) {
    throw new Error(`Invalid session event at ${path}:${lineNumber}`);
  }

  return value as SessionEvent;
}

function validPayload(event: Record<string, unknown>): boolean {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const call = (value: unknown): boolean => object(value) && typeof value.id === "string" && typeof value.name === "string";
  const message = (value: unknown): boolean => object(value) && ["system", "user", "assistant", "tool"].includes(String(value.role)) && Array.isArray(value.content) && value.content.every((part) => object(part) && (part.type === "json" || ["text", "reasoning"].includes(String(part.type)) && typeof part.text === "string" || ["image", "audio", "file"].includes(String(part.type)) && object(part.source) || part.type === "resource" && typeof part.uri === "string")) && (value.toolCalls === undefined || Array.isArray(value.toolCalls) && value.toolCalls.every(call));
  if ((String(event.type).startsWith("run.") || String(event.type).startsWith("tool.") || event.type === "assistant.completed") && typeof event.runId !== "string") return false;
  if ((String(event.type).startsWith("tool.") || event.type === "assistant.completed") && (!Number.isSafeInteger(event.step) || Number(event.step) < 1)) return false;
  switch (event.type) {
    case "session.created": return event.metadata === undefined || object(event.metadata);
    case "state.updated": return typeof event.key === "string";
    case "input.submitted": case "assistant.completed": return message(event.message);
    case "context.compacted": return Array.isArray(event.messages) && event.messages.every(message) && typeof event.strategy === "string";
    case "tool.started": case "tool.completed": return call(event.call);
    case "tool.failed": return call(event.call) && object(event.error) && typeof event.error.message === "string";
    case "tool.presentation": return typeof event.toolCallId === "string" && typeof event.kind === "string" && Number.isSafeInteger(event.version);
    case "run.started": case "run.cancelled": return true;
    case "run.failed": return object(event.error) && typeof event.error.message === "string";
    case "run.completed": case "run.yielded": return object(event.result);
    case "run.budget.exceeded": return typeof event.dimension === "string" && object(event.budget);
    case "run.interrupted": return Array.isArray(event.recoveries) && event.recoveries.every((value) => object(value) && typeof value.id === "string" && typeof value.runId === "string" && Number.isSafeInteger(value.step) && call(value.call) && ["unknown", "not-started"].includes(String(value.status)));
    case "recovery.resolved": return typeof event.recoveryId === "string" && message(event.message);
    case "approval.requested": return object(event.request) && typeof event.request.id === "string" && object(event.request.tool) && typeof event.request.tool.name === "string";
    case "approval.resolved": return typeof event.requestId === "string" && ["allow", "allow-session", "deny"].includes(String(event.decision));
    case "approval.cancelled": return typeof event.requestId === "string";
    default: return false;
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === code;
}
