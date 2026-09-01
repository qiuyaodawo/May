import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { SessionEvent } from "./events.js";
import {
  type SessionStore,
  validateSessionHistory,
} from "./store.js";

export class FileSessionStore implements SessionStore {
  readonly directory: string;

  private readonly tails = new Map<string, Promise<void>>();

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  append(event: SessionEvent): Promise<void> {
    const previous = this.tails.get(event.sessionId) ?? Promise.resolve();
    const operation = previous.then(() => this.appendNow(event));
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(event.sessionId, tail);
    void tail.finally(() => {
      if (this.tails.get(event.sessionId) === tail) {
        this.tails.delete(event.sessionId);
      }
    });
    return operation;
  }

  async read(sessionId: string): Promise<readonly SessionEvent[]> {
    await this.tails.get(sessionId);
    return this.readNow(sessionId);
  }

  async delete(sessionId: string): Promise<boolean> {
    await this.tails.get(sessionId);
    try {
      await rm(this.filePath(sessionId));
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async appendNow(event: SessionEvent): Promise<void> {
    const events = await this.readNow(event.sessionId);
    const expectedSeq = events.length + 1;

    if (event.seq !== expectedSeq) {
      throw new Error(
        `Expected session event sequence ${expectedSeq}, received ${event.seq}`,
      );
    }

    await mkdir(this.directory, { recursive: true });
    await appendFile(
      this.filePath(event.sessionId),
      `${JSON.stringify(event)}\n`,
      "utf8",
    );
  }

  private async readNow(sessionId: string): Promise<readonly SessionEvent[]> {
    const path = this.filePath(sessionId);
    let contents: string;

    try {
      contents = await readFile(path, "utf8");
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
    !Number.isInteger(value.seq) ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "number"
  ) {
    throw new Error(`Invalid session event at ${path}:${lineNumber}`);
  }

  return value as SessionEvent;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error &&
    "code" in error &&
    error.code === code;
}
