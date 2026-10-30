import type { SessionEvent } from "./events.js";
import { readRecordedModelRequests } from "./requests.js";

export interface SessionStore {
  /** 持久化目录；内存存储为 undefined，宿主可用它选择自己的记录目录。 */
  readonly directory?: string;
  append(event: SessionEvent): Promise<void>;
  /** 按顺序保存一个批次，成功返回前完成持久化。 */
  appendBatch?(events: readonly SessionEvent[]): Promise<void>;
  read(sessionId: string): Promise<readonly SessionEvent[]>;
  /** Read committed records without repair, ownership changes or other writes. */
  inspect?(sessionId: string): Promise<readonly SessionEvent[]>;
  /** Delete one durable history when supported by the store. */
  delete?(sessionId: string): Promise<boolean>;
}

export function validateSessionHistory(
  sessionId: string,
  events: readonly SessionEvent[],
): void {
  readRecordedModelRequests(events);
  const continuations = new Set<string>();
  const startedContinuations = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.sessionId !== sessionId) {
      throw new Error(
        `Expected session id "${sessionId}", received "${event.sessionId}"`,
      );
    }

    const expectedSeq = index + 1;
    if (event.seq !== expectedSeq) {
      throw new Error(
        `Expected session event sequence ${expectedSeq}, received ${event.seq}`,
      );
    }
    if (event.type === "continuation.submitted") {
      if (typeof event.continuationId !== "string" || event.continuationId.trim() === "" || event.continuationId.length > 256 || continuations.has(event.continuationId)) {
        throw new Error("Invalid or duplicate continuation identity");
      }
      continuations.add(event.continuationId);
    }
    if (event.type === "run.started" && event.continuationId !== undefined) {
      if (event.continuation !== true || !continuations.has(event.continuationId) || startedContinuations.has(event.continuationId)) {
        throw new Error("Run has no unique submitted continuation identity");
      }
      startedContinuations.add(event.continuationId);
    }
  }
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionEvent[]>();

  async append(event: SessionEvent): Promise<void> {
    const events = this.sessions.get(event.sessionId) ?? [];
    const expectedSeq = events.length + 1;

    if (event.seq !== expectedSeq) {
      throw new Error(
        `Expected session event sequence ${expectedSeq}, received ${event.seq}`,
      );
    }

    events.push(event);
    this.sessions.set(event.sessionId, events);
  }

  async read(sessionId: string): Promise<readonly SessionEvent[]> {
    return [...(this.sessions.get(sessionId) ?? [])];
  }

  inspect(sessionId: string): Promise<readonly SessionEvent[]> { return this.read(sessionId); }

  async delete(sessionId: string): Promise<boolean> {
    return this.sessions.delete(sessionId);
  }
}
