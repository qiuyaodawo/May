import type { Tool } from "@may/core";
import {
  SESSION_EVENT_TYPES,
  type SessionEvent,
  type SessionEventType,
  type SessionHistoryPage,
  type SessionHistoryQuery,
} from "@may/session";

export const DEFAULT_SESSION_HISTORY_MAX_EVENTS = 50;
export const DEFAULT_SESSION_HISTORY_MAX_OUTPUT_BYTES = 32 * 1024;
export const DEFAULT_SESSION_HISTORY_MAX_EVENT_BYTES = 8 * 1024;

export interface SessionHistorySource {
  queryHistory(query?: SessionHistoryQuery): Promise<SessionHistoryPage>;
}

export interface SessionHistoryToolOptions {
  readonly source: SessionHistorySource | (() => SessionHistorySource);
  readonly maxEvents?: number;
  readonly maxOutputBytes?: number;
  readonly maxEventBytes?: number;
}

export interface SessionHistoryToolInput extends SessionHistoryQuery {}

export interface SessionHistoryEntry {
  readonly seq: number;
  readonly timestamp: number;
  readonly type: SessionEventType;
  readonly event?: unknown;
  readonly preview?: string;
  readonly truncated?: boolean;
}

export interface SessionHistoryToolOutput {
  readonly events: readonly SessionHistoryEntry[];
  readonly hasMore: boolean;
  readonly nextSeq?: number;
  readonly outputTruncated: boolean;
}

export function createSessionHistoryTool(
  options: SessionHistoryToolOptions,
): Tool<SessionHistoryToolInput, SessionHistoryToolOutput> {
  const maxEvents = positiveInteger(
    options.maxEvents ?? DEFAULT_SESSION_HISTORY_MAX_EVENTS,
    "maxEvents",
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_SESSION_HISTORY_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const maxEventBytes = positiveInteger(
    options.maxEventBytes ?? DEFAULT_SESSION_HISTORY_MAX_EVENT_BYTES,
    "maxEventBytes",
  );
  if (maxEventBytes > maxOutputBytes) {
    throw new RangeError("maxEventBytes cannot exceed maxOutputBytes");
  }

  return {
    name: "session_history",
    description:
      "Read a bounded page of durable events from the current session. " +
      "Use this after context compaction when details from earlier work are needed.",
    inputSchema: {
      type: "object",
      properties: {
        afterSeq: {
          type: "integer",
          minimum: 1,
          description: "Return events after this exclusive sequence number",
        },
        beforeSeq: {
          type: "integer",
          minimum: 1,
          description: "Return events before this exclusive sequence number",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: maxEvents,
          description: "Maximum number of events to return",
        },
        order: { type: "string", enum: ["asc", "desc"] },
        types: {
          type: "array",
          minItems: 1,
          uniqueItems: true,
          items: { type: "string", enum: [...SESSION_EVENT_TYPES] },
        },
      },
      additionalProperties: false,
    },
    parse(input) {
      return parseInput(input, maxEvents);
    },
    async execute(input, context) {
      throwIfAborted(context.signal);
      const source = typeof options.source === "function"
        ? options.source()
        : options.source;
      const page = await source.queryHistory({
        ...input,
        limit: input.limit ?? maxEvents,
      });
      throwIfAborted(context.signal);
      return boundPage(page, maxOutputBytes, maxEventBytes);
    },
  };
}

function parseInput(input: unknown, maxEvents: number): SessionHistoryToolInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("session_history input must be an object");
  }
  const value = input as Record<string, unknown>;
  const known = new Set(["afterSeq", "beforeSeq", "limit", "order", "types"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new TypeError(`session_history: unknown field ${key}`);
  }
  const afterSeq = optionalPositiveInteger(value.afterSeq, "afterSeq");
  const beforeSeq = optionalPositiveInteger(value.beforeSeq, "beforeSeq");
  if (afterSeq !== undefined && beforeSeq !== undefined && afterSeq >= beforeSeq) {
    throw new RangeError("session_history: afterSeq must be less than beforeSeq");
  }
  const limit = optionalPositiveInteger(value.limit, "limit");
  if (limit !== undefined && limit > maxEvents) {
    throw new RangeError(`session_history: limit cannot exceed ${maxEvents}`);
  }
  const order = value.order;
  if (order !== undefined && order !== "asc" && order !== "desc") {
    throw new TypeError('session_history: order must be "asc" or "desc"');
  }
  const types = parseTypes(value.types);
  return {
    ...(afterSeq === undefined ? {} : { afterSeq }),
    ...(beforeSeq === undefined ? {} : { beforeSeq }),
    ...(limit === undefined ? {} : { limit }),
    ...(order === undefined ? {} : { order }),
    ...(types === undefined ? {} : { types }),
  };
}

function parseTypes(value: unknown): readonly SessionEventType[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("session_history: types must be a non-empty array");
  }
  const allowed = new Set<string>(SESSION_EVENT_TYPES);
  const types: SessionEventType[] = [];
  for (const type of value) {
    if (typeof type !== "string" || !allowed.has(type)) {
      throw new TypeError(`session_history: unknown event type ${String(type)}`);
    }
    if (!types.includes(type as SessionEventType)) {
      types.push(type as SessionEventType);
    }
  }
  return types;
}

function boundPage(
  page: SessionHistoryPage,
  maxOutputBytes: number,
  maxEventBytes: number,
): SessionHistoryToolOutput {
  const entries: SessionHistoryEntry[] = [];
  let bytes = utf8Bytes('{"events":[],"hasMore":false,"outputTruncated":false}');
  let outputTruncated = false;

  for (const event of page.events) {
    const entry = projectEvent(event, maxEventBytes);
    const entryBytes = utf8Bytes(JSON.stringify(entry)) + 1;
    if (bytes + entryBytes > maxOutputBytes) {
      const minimal: SessionHistoryEntry = {
        seq: event.seq,
        timestamp: event.timestamp,
        type: event.type,
        truncated: true,
      };
      if (bytes + utf8Bytes(JSON.stringify(minimal)) + 1 <= maxOutputBytes) {
        entries.push(minimal);
      }
      outputTruncated = true;
      break;
    }
    entries.push(entry);
    bytes += entryBytes;
  }

  const hasMore = page.hasMore || entries.length < page.events.length;
  const last = entries[entries.length - 1];
  return {
    events: entries,
    hasMore,
    ...(hasMore && last !== undefined
      ? { nextSeq: last.seq }
      : page.nextSeq === undefined
      ? {}
      : { nextSeq: page.nextSeq }),
    outputTruncated,
  };
}

function projectEvent(event: SessionEvent, maxEventBytes: number): SessionHistoryEntry {
  let projected: unknown = event;
  if (event.type === "context.compacted") {
    const { messages, ...details } = event;
    projected = {
      ...details,
      replacementMessageCount: messages.length,
    };
  }
  const serialized = JSON.stringify(projected);
  if (utf8Bytes(serialized) <= maxEventBytes) {
    return {
      seq: event.seq,
      timestamp: event.timestamp,
      type: event.type,
      event: projected,
    };
  }
  return {
    seq: event.seq,
    timestamp: event.timestamp,
    type: event.type,
    preview: truncateUtf8(serialized, maxEventBytes),
    truncated: true,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const suffix = "…[truncated]";
  const suffixBytes = utf8Bytes(suffix);
  if (suffixBytes >= maxBytes) return suffix.slice(0, Math.max(1, maxBytes));
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) + suffixBytes <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low)}${suffix}`;
}

function optionalPositiveInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, `session_history: ${name}`);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value as number;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "session_history cancelled",
  );
  error.name = "AbortError";
  throw error;
}
