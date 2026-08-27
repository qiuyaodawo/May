import type { SessionEvent } from "./events.js";

export interface SessionStore {
  append(event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<readonly SessionEvent[]>;
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
}
