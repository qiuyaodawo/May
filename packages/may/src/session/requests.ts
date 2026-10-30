import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import type { ModelRequestRecord } from "../core/request-recording.js";
import type { SessionEvent } from "./events.js";

export type RequestReferences = Readonly<Record<string, string | readonly string[]>>;
export type SessionRequestEvent =
  | { type: "model.request.defined"; id: string; value: unknown }
  | { type: "model.request.prepared"; version: 1; runId: string; step: number; modelCallId: string; attempt: number; adapter: string; purpose: "generation" | "compaction"; request: RequestReferences; body?: RequestReferences | undefined; endpoint?: string; protocol?: Readonly<Record<string, string>>; omittedPaths?: readonly string[]; externalResourcePaths?: readonly string[] }
  | { type: "model.attempt.started"; runId: string; step: number; modelCallId: string; attempt: number }
  | { type: "model.attempt.completed"; runId: string; step: number; modelCallId: string; attempt: number; durationMs: number; usage?: import("../core/types.js").Usage }
  | { type: "model.attempt.failed"; runId: string; step: number; modelCallId: string; attempt: number; cancelled: boolean; errorName: string; durationMs: number; httpStatus?: number };

export interface RecordedModelRequest {
  readonly outcome?: Extract<SessionRequestEvent, { type: "model.attempt.completed" | "model.attempt.failed" }>;
  readonly runId: string;
  readonly step: number;
  readonly modelCallId: string;
  readonly attempt: number;
  readonly seq: number;
  readonly status: "prepared" | "unknown" | "completed" | "failed" | "cancelled";
  readonly record: ModelRequestRecord;
}

export function requestValueId(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function requestReferences(value: Readonly<Record<string, unknown>>, define: (value: unknown) => string): RequestReferences {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, Array.isArray(item) ? item.map(define) : define(item)]));
}

export function readRecordedModelRequests(events: readonly SessionEvent[]): RecordedModelRequest[] {
  const values = new Map<string, unknown>();
  const requests: RecordedModelRequest[] = [];
  const pending = new Map<string, number>();
  const resolve = (id: string): unknown => {
    if (!values.has(id)) throw new Error(`Missing request definition: ${id}`);
    return structuredClone(values.get(id));
  };
  const restore = (refs: RequestReferences) => Object.fromEntries(Object.entries(refs ?? {}).map(([key, value]) => [key, typeof value === "string" ? resolve(value) : value.map(resolve)]));
  for (const event of events) {
    if (event.type === "model.request.defined") {
      if (requestValueId(event.value) !== event.id) throw new Error("Invalid request definition digest");
      values.set(event.id, event.value);
    } else if (event.type === "model.request.prepared") {
      if (event.version !== 1) throw new Error("Unsupported model request record version");
      if (!event.modelCallId || !event.runId || !event.adapter || !Number.isSafeInteger(event.step) || event.step < 1 || !Number.isSafeInteger(event.attempt) || event.attempt < 1 || !["generation", "compaction"].includes(event.purpose)) throw new Error("Invalid prepared request identity");
      const key = `${event.modelCallId}:${event.attempt}`;
      if (pending.has(key)) throw new Error("Duplicate recorded model attempt");
      pending.set(key, requests.length);
      const request = restore(event.request) as unknown as ModelRequestRecord["request"];
      if (!Array.isArray(request.messages) || !Array.isArray(request.tools)) throw new Error("Invalid recorded Core request");
      requests.push({ runId: event.runId, step: event.step, modelCallId: event.modelCallId, attempt: event.attempt, seq: event.seq, status: "prepared", record: {
        version: 1, adapter: event.adapter, purpose: event.purpose,
        request, ...(event.body === undefined ? {} : { body: restore(event.body) }),
        ...(event.protocol === undefined ? {} : { protocol: event.protocol }),
        ...(event.endpoint === undefined ? {} : { endpoint: event.endpoint }),
        ...(event.omittedPaths === undefined ? {} : { omittedPaths: event.omittedPaths }),
        ...(event.externalResourcePaths === undefined ? {} : { externalResourcePaths: event.externalResourcePaths }),
      } });
    } else if (event.type === "model.attempt.started" || event.type === "model.attempt.completed" || event.type === "model.attempt.failed") {
      const index = pending.get(`${event.modelCallId}:${event.attempt}`);
      if (index === undefined || requests[index]!.status !== (event.type === "model.attempt.started" ? "prepared" : "unknown")) throw new Error("Invalid recorded model attempt outcome");
      requests[index] = { ...requests[index]!, ...(event.type === "model.attempt.started" ? {} : { outcome: event }), status: event.type === "model.attempt.started" ? "unknown" : event.type === "model.attempt.completed" ? "completed" : event.cancelled ? "cancelled" : "failed" };
    }
  }
  return structuredClone(requests);
}
