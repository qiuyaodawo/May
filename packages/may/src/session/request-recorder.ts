import { omitUndefined } from "../core/index.js";
import type { ModelRequestSink } from "../core/request-recording.js";
import type { SessionEventPayload } from "./events.js";
import { requestReferences, requestValueId } from "./requests.js";

export function prepareModelRequest(
  observation: Extract<Parameters<ModelRequestSink>[0], { type: "prepared" }>,
  providerBodyRecording: boolean,
  requestDefinitions: ReadonlySet<string>,
  requestAttempts: ReadonlyMap<string, number>,
): { batch: SessionEventPayload[]; added: Array<{ id: string; value: unknown }>; attempt: number } {
  const identity = { runId: observation.runId, step: observation.step, modelCallId: observation.modelCallId };
  if (
    new TextEncoder().encode(
      JSON.stringify({
        ...observation.record,
        body: providerBodyRecording ? observation.record.body : undefined,
      }),
    ).byteLength >
    64 * 1024 * 1024
  )
    throw new RangeError("Model request record exceeds 64 MiB");
  const definitions = new Set(requestDefinitions);
  const added: Array<{ id: string; value: unknown }> = [];
  const define = (value: unknown): string => {
    const id = requestValueId(value);
    if (!definitions.has(id)) {
      definitions.add(id);
      added.push({ id, value });
    }
    return id;
  };
  const record = observation.record;
  if (providerBodyRecording && (typeof record.body !== "object" || record.body === null || Array.isArray(record.body)))
    throw new TypeError("Recorded request body must be an object");
  const request = requestReferences({ ...record.request }, define);
  const body = providerBodyRecording ? requestReferences(record.body as Record<string, unknown>, define) : undefined;
  const batch: SessionEventPayload[] = added.map((definition) => ({
    type: "model.request.defined",
    ...definition,
  }));
  const attempt = (requestAttempts.get(observation.modelCallId) ?? 0) + 1;
  batch.push({
    type: "model.request.prepared",
    version: 1,
    ...identity,
    attempt,
    adapter: record.adapter,
    purpose: record.purpose,
    request,
    body,
    ...omitUndefined({
      endpoint: record.endpoint,
      protocol: record.protocol,
      omittedPaths: record.omittedPaths,
      externalResourcePaths: record.externalResourcePaths,
    }),
  });
  return { batch, added, attempt };
}
