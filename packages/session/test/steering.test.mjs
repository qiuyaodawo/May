import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import test from "node:test";
import { FileSessionStore } from "../dist/file-store.js";
import { SessionSteeringQueue } from "../dist/steering.js";
import { SessionHistoryReader } from "../dist/history.js";

async function openQueue(t) {
  const root = resolve(import.meta.dirname, "../../../.zcode/tmp/session-steering-tests");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "history-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${root}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const store = new FileSessionStore(directory);
  let seq = 0;
  const record = (event) => store.append({ ...event, sessionId: "steering", seq: ++seq, timestamp: Date.now() });
  await record({ type: "session.created" });
  return { queue: new SessionSteeringQueue(record), store, record };
}

test("durable steering inputs retain FIFO order and delivery through reopening", async (t) => {
  const { queue, store, record } = await openQueue(t);
  const first = queue.enqueue({ inputId: "first", input: "检查错误处理" }, "run-1");
  const second = queue.enqueue({ inputId: "second", input: "检查权限" }, "run-1");
  assert.equal((await first).status, "pending");
  assert.equal((await second).status, "pending");
  const messages = await queue.deliver("run-1", 2, new AbortController().signal);
  assert.deepEqual(messages.map((message) => message.content[0].text), ["检查错误处理", "检查权限"]);
  assert.deepEqual(queue.list().map((input) => input.status), ["delivered", "delivered"]);
  const reopened = new SessionSteeringQueue(record, await store.read("steering"));
  assert.deepEqual(reopened.list(), queue.list());
  const history = await new SessionHistoryReader(store).query("steering", { types: ["input.steering.delivered"] });
  assert.equal(history.events.length, 1);
  assert.deepEqual(await reopened.deliver("run-1", 3, new AbortController().signal), []);
});

test("cancellation before the boundary preserves undelivered inputs and rejects later delivery", async (t) => {
  const { queue, store, record } = await openQueue(t);
  await queue.enqueue({ inputId: "pending", input: "补充条件" }, "run-1");
  const controller = new AbortController();
  controller.abort("用户停止");
  assert.deepEqual(await queue.deliver("run-1", 1, controller.signal), []);
  await queue.finish("run-1", "cancelled", "用户停止");
  const reopened = new SessionSteeringQueue(record, await store.read("steering"));
  assert.equal(reopened.list()[0].status, "cancelled");
  assert.throws(() => reopened.idle("pending"), /not available/);
  assert.deepEqual(await reopened.deliver("run-2", 1, new AbortController().signal), []);
});

test("completed and yielded runs retain ordered inputs for explicit subsequent runs", async (t) => {
  const { queue, record, store } = await openQueue(t);
  await queue.enqueue({ inputId: "first", input: "第一条" }, "run-1");
  await queue.enqueue({ inputId: "second", input: "第二条" }, "run-1");
  await queue.finish("run-1", "idle", "yielded");
  assert.throws(() => queue.idle("second"), /earlier steering input/);
  const first = queue.idle("first");
  await record({ type: "input.submitted", inputId: first.inputId, message: first.message });
  queue.submitted(first.inputId);
  assert.equal(queue.idle("second").inputId, "second");
  const reopened = new SessionSteeringQueue(record, await store.read("steering"));
  assert.deepEqual(reopened.list().map((input) => input.status), ["delivered", "idle"]);
});

test("idle inputs have no target run and request identities remain unique", async (t) => {
  const { queue } = await openQueue(t);
  assert.throws(() => queue.enqueue({ input: "过期目标", runId: "old" }, "current"), /no longer active/);
  const pending = queue.enqueue({ inputId: "one", input: "独立输入" });
  await assert.rejects(queue.enqueue({ inputId: "one", input: "重复输入" }), /already exists/);
  const input = await pending;
  assert.equal(input.status, "idle");
  assert.equal(input.runId, undefined);
  assert.equal((await queue.enqueue({ inputId: "two", input: "后续输入" })).status, "idle");
  const copy = queue.list();
  copy[0].message.content[0].text = "外部修改";
  assert.equal(queue.list()[0].message.content[0].text, "独立输入");
});

test("explicit stop durably cancels idle and pending input while preserving delivered input", async t => {
  const { queue, store, record } = await openQueue(t);
  await queue.enqueue({ inputId: "delivered", input: "已交付" }, "first");
  await queue.deliver("first", 1, new AbortController().signal);
  await queue.enqueue({ inputId: "idle", input: "空闲补充" });
  await queue.enqueue({ inputId: "pending", input: "等待步骤" }, "second");
  await queue.cancel("用户明确停止");
  const reopened = new SessionSteeringQueue(record, await store.read("steering"));
  assert.deepEqual(reopened.list().map(input => input.status), ["delivered", "cancelled", "cancelled"]);
  assert.deepEqual(await reopened.deliver("second", 1, new AbortController().signal), []);
  assert.throws(() => reopened.idle("idle"), /not available/);
});

test("a terminal transition follows all accepted inputs while a new run remains independent", async (t) => {
  const { queue, record, store } = await openQueue(t);
  const acceptance = queue.enqueue({ inputId: "old", input: "旧执行补充" }, "run-1");
  const finished = queue.finish("run-1", "cancelled", "用户停止");
  const current = queue.enqueue({ inputId: "current", input: "新执行补充" }, "run-2");
  await Promise.all([acceptance, finished, current]);
  const messages = await queue.deliver("run-2", 1, new AbortController().signal);
  assert.deepEqual(messages.map((message) => message.content[0].text), ["新执行补充"]);
  const reopened = new SessionSteeringQueue(record, await store.read("steering"));
  assert.deepEqual(reopened.list().map((input) => input.status), ["cancelled", "delivered"]);
});
