import type { SessionEvent } from "./events.js";
import type { SessionStore } from "./store.js";
import { validateSessionHistory } from "./store.js";

export type SessionEventType = SessionEvent["type"];

export interface SessionHistoryQuery {
  readonly afterSeq?: number;
  readonly beforeSeq?: number;
  readonly limit?: number;
  readonly order?: "asc" | "desc";
  readonly types?: readonly SessionEventType[];
}

export interface SessionHistoryPage {
  readonly events: readonly SessionEvent[];
  readonly hasMore: boolean;
  /**
   * Exclusive sequence boundary for the next page. Pass it as `afterSeq` for
   * ascending queries and `beforeSeq` for descending queries.
   */
  readonly nextSeq?: number;
}

export interface SessionHistoryReaderOptions {
  readonly defaultLimit?: number;
  readonly maximumLimit?: number;
}

export class SessionHistoryReader {
  private readonly defaultLimit: number;
  private readonly maximumLimit: number;

  constructor(
    private readonly store: SessionStore,
    options: SessionHistoryReaderOptions = {},
  ) {
    this.defaultLimit = positiveInteger(options.defaultLimit ?? 50, "defaultLimit");
    this.maximumLimit = positiveInteger(options.maximumLimit ?? 1000, "maximumLimit");
    if (this.defaultLimit > this.maximumLimit) {
      throw new RangeError("defaultLimit cannot exceed maximumLimit");
    }
  }

  async readAll(sessionId: string): Promise<readonly SessionEvent[]> {
    requireSessionId(sessionId);
    const events = await this.store.read(sessionId);
    validateSessionHistory(sessionId, events);
    return [...events];
  }

  async query(
    sessionId: string,
    query: SessionHistoryQuery = {},
  ): Promise<SessionHistoryPage> {
    const normalized = this.normalizeQuery(query);
    const all = await this.readAll(sessionId);
    const selected = all.filter((event) =>
      (normalized.afterSeq === undefined || event.seq > normalized.afterSeq) &&
      (normalized.beforeSeq === undefined || event.seq < normalized.beforeSeq) &&
      (normalized.types === undefined || normalized.types.has(event.type))
    );
    if (normalized.order === "desc") selected.reverse();

    const events = selected.slice(0, normalized.limit);
    const hasMore = selected.length > events.length;
    return {
      events,
      hasMore,
      ...(hasMore && events.length > 0
        ? { nextSeq: events[events.length - 1]!.seq }
        : {}),
    };
  }

  private normalizeQuery(query: SessionHistoryQuery): {
    afterSeq?: number;
    beforeSeq?: number;
    limit: number;
    order: "asc" | "desc";
    types?: ReadonlySet<SessionEventType>;
  } {
    validateOptionalSeq(query.afterSeq, "afterSeq");
    validateOptionalSeq(query.beforeSeq, "beforeSeq");
    if (
      query.afterSeq !== undefined &&
      query.beforeSeq !== undefined &&
      query.afterSeq >= query.beforeSeq
    ) {
      throw new RangeError("afterSeq must be less than beforeSeq");
    }
    const limit = query.limit === undefined
      ? this.defaultLimit
      : positiveInteger(query.limit, "limit");
    if (limit > this.maximumLimit) {
      throw new RangeError(`limit cannot exceed ${this.maximumLimit}`);
    }
    if (query.order !== undefined && query.order !== "asc" && query.order !== "desc") {
      throw new TypeError('order must be either "asc" or "desc"');
    }
    const types = query.types === undefined
      ? undefined
      : new Set(query.types);
    if (types?.size === 0) {
      throw new RangeError("types cannot be empty");
    }
    for (const type of types ?? []) validateEventType(type);
    return {
      ...(query.afterSeq === undefined ? {} : { afterSeq: query.afterSeq }),
      ...(query.beforeSeq === undefined ? {} : { beforeSeq: query.beforeSeq }),
      limit,
      order: query.order ?? "asc",
      ...(types === undefined ? {} : { types }),
    };
  }
}

export const SESSION_EVENT_TYPES: readonly SessionEventType[] = [
  "session.created",
  "input.submitted",
  "run.started",
  "context.compacted",
  "assistant.completed",
  "tool.completed",
  "tool.failed",
  "tool.presentation",
  "approval.requested",
  "approval.resolved",
  "approval.cancelled",
  "run.completed",
  "run.failed",
  "run.cancelled",
] as const;

const SESSION_EVENT_TYPE_SET: ReadonlySet<string> = new Set(
  SESSION_EVENT_TYPES,
);

function validateEventType(type: SessionEventType): void {
  if (typeof type !== "string" || !SESSION_EVENT_TYPE_SET.has(type)) {
    throw new TypeError(`Unknown session event type: ${String(type)}`);
  }
}

function validateOptionalSeq(value: number | undefined, name: string): void {
  if (value !== undefined) positiveInteger(value, name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function requireSessionId(sessionId: string): void {
  if (sessionId.trim() === "") throw new Error("sessionId cannot be empty");
}
