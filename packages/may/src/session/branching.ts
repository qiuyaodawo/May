import type { UserMessage } from "../core/index.js";
import type { SessionEvent, SessionEventPayload } from "./events.js";
import type { SessionForkOptions } from "./session.js";

export function appendForkHistory(
  source: readonly SessionEvent[],
  options: SessionForkOptions,
  runId: string,
  append: (event: SessionEventPayload, timestamp: number) => number,
): Extract<SessionEvent, { type: "session.created" }> {
  const stateKeys = new Set(options.stateKeys ?? []);
  const queued = new Map<string, UserMessage>();
  const created = source[0];
  if (created?.type !== "session.created") throw new Error("Source Session has no creation event");
  append(
    {
      type: "session.created",
      ...(created.runtime === undefined ? {} : { runtime: created.runtime }),
      ...((options.metadata ?? created.metadata) === undefined
        ? {}
        : { metadata: { ...(options.metadata ?? created.metadata) } }),
      fork: { sessionId: options.sourceId, positionSeq: options.positionSeq, runId },
    },
    Date.now(),
  );
  for (const event of source.slice(1, options.positionSeq)) {
    if (event.type.startsWith("approval.") || event.type.startsWith("rule.")) {
      append({ type: "history.omitted", reason: "permission" }, event.timestamp);
      continue;
    }
    if (event.type === "session.fork.ready") {
      append({ type: "history.omitted", reason: "fork-initialization" }, event.timestamp);
      continue;
    }
    if (event.type === "state.updated") {
      if (stateKeys.has(event.key))
        append(
          {
            type: "state.updated",
            key: event.key,
            value:
              options.transformState === undefined
                ? event.value
                : options.transformState(event.key, structuredClone(event.value)),
          },
          event.timestamp,
        );
      else append({ type: "history.omitted", reason: "application-state" }, event.timestamp);
      continue;
    }
    if (event.type === "input.steering.queued") {
      queued.set(event.input.inputId, event.input.message);
      append({ type: "history.omitted", reason: "unconsumed-input" }, event.timestamp);
      continue;
    }
    if (event.type === "input.steering.finished") {
      append({ type: "history.omitted", reason: "unconsumed-input" }, event.timestamp);
      continue;
    }
    if (event.type === "input.steering.delivered") {
      const messages = event.inputIds.map((inputId) => {
        const message = queued.get(inputId);
        if (message === undefined) throw new Error(`Delivered input has no saved content: ${inputId}`);
        return message;
      });
      append(
        {
          type: "input.generated",
          runId: event.runId,
          step: event.step,
          messages,
          reason: "Inherited delivered input",
        },
        event.timestamp,
      );
      continue;
    }
    if (event.type === "input.submitted") {
      append({ type: "input.submitted", message: event.message }, event.timestamp);
      continue;
    }
    if (event.type === "continuation.submitted") {
      append({ type: "history.omitted", reason: "execution-identity" }, event.timestamp);
      continue;
    }
    if (event.type === "run.started" && event.continuationId !== undefined) {
      const { continuationId: _identity, ...started } = event;
      append(started, event.timestamp);
      continue;
    }
    append(event, event.timestamp);
  }
  return created;
}
