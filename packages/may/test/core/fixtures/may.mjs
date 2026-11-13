import assert from "node:assert/strict";

export function assistant(text, toolCalls) {
  const message = {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
  };
  if (toolCalls) message.toolCalls = toolCalls;
  return message;
}

export async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

export function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export function waitForAbort(signal) {
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }

  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

export function assertSingleTerminalEvent(events, expectedType) {
  const terminals = events.filter(
    (event) => event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled",
  );

  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].type, expectedType);
  assert.equal(events.at(-1), terminals[0]);
}
