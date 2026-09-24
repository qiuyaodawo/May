import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { FileSessionStore } from "@may/session/file-store";
import { SessionSteeringQueue } from "../../../session/dist/steering.js";
import { UiProjection } from "../dist/projection.js";
import { recordedField, searchHistory } from "../dist/reading.js";

test("file history and live projection retain steering text, FIFO order, and full searchable fields", async t => {
  const root = resolve(import.meta.dirname, "../../../../.zcode/tmp/ui-steering");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "history-"));
  t.after(async () => { assert.ok(resolve(directory).startsWith(root + sep)); await rm(directory, { recursive: true, force: true }); });
  const store = new FileSessionStore(directory);
  let seq = 0;
  const record = event => store.append({ ...event, sessionId: "steering", seq: ++seq, timestamp: seq });
  await record({ type: "session.created" });
  await record({ type: "input.submitted", message: { role: "user", content: [{ type: "text", text: "Original request" }] } });
  const queue = new SessionSteeringQueue(record);
  const first = "Additional context ".repeat(5000) + "search-at-end";
  await queue.enqueue({ inputId: "first", input: first }, "active");
  await queue.enqueue({ inputId: "second", input: "Second message" }, "active");
  const before = new UiProjection(); before.history(await store.inspect("steering"));
  assert.equal(before.blocks.size, 1);
  const messages = await queue.deliver("active", 1, new AbortController().signal);
  await queue.enqueue({ inputId: "cancelled", input: "Do not deliver" });
  await queue.cancel("Stopped");
  const idle = await queue.enqueue({ inputId: "idle", input: "Idle follow-up" });
  await record({ type: "input.submitted", inputId: idle.inputId, message: idle.message });
  queue.submitted(idle.inputId);

  const history = await new FileSessionStore(directory).inspect("steering");
  const projection = new UiProjection(); projection.history(history);
  const blocks = [...projection.blocks.values()];
  assert.deepEqual(blocks.map(block => block.id), ["input:2", "steering:active:1:0", "steering:active:1:1", `input:${seq}`]);
  assert.equal(blocks[1].runId, "active");
  assert.equal(blocks[2].text, "Second message");
  assert.equal(blocks[3].text, "Idle follow-up");
  assert.ok(blocks[1].text.length < first.length);
  assert.equal(recordedField(history, blocks[1], "text"), first);
  assert.deepEqual([...searchHistory(history, "search-at-end")], [blocks[1].id]);
  assert.equal(searchHistory(history, "Do not deliver").size, 0);

  const live = new UiProjection();
  const event = { type: "run.event", event: { type: "input.received", runId: "active", step: 1, seq: 1, timestamp: 1, messages } };
  live.event(event); live.event(event);
  assert.deepEqual([...live.blocks.values()], blocks.slice(1, 3));
});
