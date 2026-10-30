import type { Model, ModelRequest, ModelEvent } from "./model.js";
import { RunCheckpointError } from "./errors.js";

export interface ModelRequestRecord {
  readonly version: 1;
  readonly adapter: string;
  readonly purpose: "generation" | "compaction";
  readonly request: ModelRequest;
  readonly body?: unknown;
  readonly endpoint?: string;
  readonly protocol?: Readonly<Record<string, string>>;
  readonly omittedPaths?: readonly string[];
  readonly externalResourcePaths?: readonly string[];
}

export type ModelRequestObservation =
  | { readonly type: "prepared"; readonly record: ModelRequestRecord }
  | { readonly type: "started" }
  | { readonly type: "completed"; readonly durationMs: number; readonly usage?: import("./types.js").Usage }
  | { readonly type: "failed"; readonly cancelled: boolean; readonly errorName: string; readonly durationMs: number; readonly httpStatus?: number };

export type ModelRequestRecorder = (event: ModelRequestObservation) => Promise<void>;

export type ModelRequestSink = (event: ModelRequestObservation & {
  readonly runId: string;
  readonly step: number;
  readonly modelCallId: string;
}) => Promise<void>;

/** 在发送请求前等待记录完成，执行时使用同一份序列化内容。 */
export async function* executeRecordedRequest(
  record: ModelRequestRecord,
  recorder: ModelRequestRecorder | undefined,
  signal: AbortSignal,
  execute: (body: string) => AsyncIterable<ModelEvent>,
): AsyncIterable<ModelEvent> {
  const body = JSON.stringify(record.body);
  await recorder?.({ type: "prepared", record: snapshotRequestRecord(record) });
  if (recorder !== undefined) signal.throwIfAborted();
  await recorder?.({ type: "started" });
  const started = performance.now();
  let usage: import("./types.js").Usage | undefined;
  try {
    for await (const event of execute(body)) {
      if (event.type === "response.completed") usage = event.usage;
      yield event;
    }
  } catch (error) {
    await recorder?.(requestFailure(error, signal, started));
    throw error;
  }
  await recorder?.({ type: "completed", durationMs: performance.now() - started, ...(usage === undefined ? {} : { usage }) });
}

export async function executeRecordedOperation<T>(record: ModelRequestRecord, recorder: ModelRequestRecorder | undefined, signal: AbortSignal, execute: (body: string) => Promise<T>): Promise<T> {
  const body = JSON.stringify(record.body);
  await recorder?.({ type: "prepared", record: snapshotRequestRecord(record) });
  if (recorder !== undefined) signal.throwIfAborted();
  await recorder?.({ type: "started" });
  const started = performance.now();
  let result: T;
  try { result = await execute(body); }
  catch (error) {
    await recorder?.(requestFailure(error, signal, started));
    throw error;
  }
  await recorder?.({ type: "completed", durationMs: performance.now() - started });
  return result;
}

function requestFailure(error: unknown, signal: AbortSignal, started: number): Extract<ModelRequestObservation, { type: "failed" }> {
  const status = error instanceof Error && "status" in error ? error.status : undefined;
  return { type: "failed", cancelled: signal.aborted, errorName: error instanceof Error ? error.name : "Error", durationMs: performance.now() - started,
    ...(typeof status === "number" && Number.isInteger(status) ? { httpStatus: status } : {}) };
}

export function requestEndpoint(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function snapshotRequestRecord(record: ModelRequestRecord): ModelRequestRecord {
  const snapshot = JSON.parse(JSON.stringify(record)) as ModelRequestRecord;
  const omittedPaths: string[] = [];
  const externalResourcePaths: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      const location = `${path}/${key}`;
      if (["url", "image_url", "uri", "fileUri", "file_uri"].includes(key) && typeof item === "string" && URL.canParse(item)) {
        const url = new URL(item);
        if (["http:", "https:"].includes(url.protocol)) {
          externalResourcePaths.push(location);
          if (url.search || url.username || url.password || url.hash) {
            url.username = ""; url.password = ""; url.search = ""; url.hash = "";
            (value as Record<string, unknown>)[key] = url.toString();
            omittedPaths.push(location);
          }
        }
      } else visit(item, location);
    }
  };
  visit(snapshot.request, "/request");
  visit(snapshot.body, "/body");
  return { ...snapshot, ...(omittedPaths.length === 0 ? {} : { omittedPaths }), ...(externalResourcePaths.length === 0 ? {} : { externalResourcePaths }) };
}

/** 让应用自行发起的摘要和原生压缩调用使用同一记录通道。 */
export function withModelRequestRecording(model: Model, sink: ModelRequestSink): Model {
  if (model.supportsRequestRecording !== true) throw new Error("Model does not support complete request recording");
  const recorder = (runId = "standalone", step = 1, purpose: "generation" | "compaction" = "generation"): ModelRequestRecorder => {
    const modelCallId = `${runId}:${purpose}:${crypto.randomUUID()}`;
    return async (event) => {
      try { await sink({ ...event, ...(event.type === "prepared" ? { record: { ...event.record, purpose } } : {}), runId, step, modelCallId }); }
      catch (error) { throw new RunCheckpointError(error); }
    };
  };
  return {
    supportsRequestRecording: true,
    get configuration() { return model.configuration; },
    get reportsAttempts() { return model.reportsAttempts; },
    get capabilityVersion() { return model.capabilityVersion; },
    get limits() { return model.limits; },
    ...(model.preflight === undefined ? {} : { preflight: model.preflight.bind(model) }),
    stream(request, options) { return model.stream(request, { ...options, recordRequest: options.recordRequest ?? recorder(options.runId, options.step, options.purpose) }); },
    ...(model.contextCompactor === undefined ? {} : { contextCompactor: {
      name: model.contextCompactor.name,
      compact(snapshot, options) { return model.contextCompactor!.compact(snapshot, { ...options, recordRequest: options.recordRequest ?? recorder(options.runId, options.step, "compaction") }); },
    } }),
  };
}
