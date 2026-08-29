import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSessionStore } from "@may/session/file-store";
import {
  InMemorySessionStore,
  SessionHistoryReader,
} from "../dist/index.js";

for (const [name, createStore] of [
  ["in-memory", async () => new InMemorySessionStore()],
  ["JSONL", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "may-history-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    return new FileSessionStore(directory);
  }],
]) {
  test(`queries ${name} session history with stable sequence cursors`, async (t) => {
    const store = await createStore(t);
    for (const event of events("history_query")) await store.append(event);
    const reader = new SessionHistoryReader(store, {
      defaultLimit: 2,
      maximumLimit: 4,
    });

    const first = await reader.query("history_query");
    assert.deepEqual(first.events.map((event) => event.seq), [1, 2]);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextSeq, 2);

    const second = await reader.query("history_query", {
      afterSeq: first.nextSeq,
      limit: 2,
    });
    assert.deepEqual(second.events.map((event) => event.seq), [3, 4]);
    assert.equal(second.hasMore, true);

    const filtered = await reader.query("history_query", {
      beforeSeq: 5,
      order: "desc",
      limit: 2,
      types: ["input.submitted", "assistant.completed"],
    });
    assert.deepEqual(filtered.events.map((event) => event.seq), [4, 2]);
    assert.equal(filtered.hasMore, false);
  });
}

test("validates history query boundaries and limits", async () => {
  const reader = new SessionHistoryReader(new InMemorySessionStore(), {
    defaultLimit: 2,
    maximumLimit: 2,
  });

  await assert.rejects(reader.query("session", { limit: 3 }), /cannot exceed 2/u);
  await assert.rejects(
    reader.query("session", { afterSeq: 2, beforeSeq: 2 }),
    /less than beforeSeq/u,
  );
  await assert.rejects(
    reader.query("session", { types: [] }),
    /types cannot be empty/u,
  );
  await assert.rejects(
    reader.query("session", { types: ["unknown"] }),
    /Unknown session event type/u,
  );
});

function events(sessionId) {
  return [
    event(sessionId, 1, { type: "session.created" }),
    event(sessionId, 2, {
      type: "input.submitted",
      message: message("first"),
    }),
    event(sessionId, 3, { type: "run.started", runId: "run_1" }),
    event(sessionId, 4, {
      type: "assistant.completed",
      runId: "run_1",
      step: 1,
      message: assistant("done"),
    }),
    event(sessionId, 5, {
      type: "run.completed",
      runId: "run_1",
      result: { runId: "run_1", steps: 1, message: assistant("done") },
    }),
  ];
}

function event(sessionId, seq, payload) {
  return { ...payload, sessionId, seq, timestamp: seq };
}

function message(text) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
