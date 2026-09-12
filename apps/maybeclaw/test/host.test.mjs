import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ChannelHub, ChannelStore, DEFAULT_TASK_BUDGET, FeishuAdapter, MaybeClaw, MaybeClawHost,
  TelegramAdapter, channelSecret, cursorId, digest, feishuInput, hostSettings, inboxId, runMaybeClaw, startControlServer, telegramInput } from "../dist/index.js";

const token = "local-test-token-not-a-real-secret-0123456789";
test("channel credentials accept either literal values or environment names without leaking invalid values", () => {
  const parse = channels => hostSettings({ apps: { maybeclaw: { channels } } });
  const telegram = { enabled: true, allowUsers: ["7"], botToken: "42:fake-inline-token" };
  const feishu = { enabled: true, appId: "cli_0123456789abcdef", allowUsers: ["ou_user"], appSecret: "fake-inline-secret" };
  const settings = parse({ telegram, feishu });
  assert.equal(settings.telegram.botTokenEnv, undefined);
  assert.equal(channelSecret(settings.telegram.botToken, settings.telegram.botTokenEnv, {}), telegram.botToken);
  assert.equal(channelSecret(settings.feishu.appSecret, settings.feishu.appSecretEnv, {}), feishu.appSecret);
  const defaults = parse({ telegram: { enabled: false }, feishu: { enabled: false } });
  assert.equal(defaults.telegram.botTokenEnv, "MAYBECLAW_TELEGRAM_TOKEN");
  assert.equal(defaults.feishu.appSecretEnv, "MAYBECLAW_FEISHU_SECRET");
  const custom = parse({ telegram: { enabled: false, botTokenEnv: "MY_TG_TOKEN" } }).telegram;
  assert.equal(channelSecret(custom.botToken, custom.botTokenEnv, { MY_TG_TOKEN: telegram.botToken }), telegram.botToken);
  assert.throws(() => channelSecret(custom.botToken, custom.botTokenEnv, {}), /Set credential environment variable MY_TG_TOKEN/);
  assert.throws(() => parse({ telegram: { ...telegram, botTokenEnv: "MY_TG_TOKEN" } }), /not both/);
  assert.throws(() => parse({ feishu: { ...feishu, appSecretEnv: "MY_SECRET" } }), /not both/);
  for (const invalid of ["", "secret with spaces", 123, null]) {
    assert.throws(() => parse({ telegram: { ...telegram, botToken: invalid } }), /Invalid botToken/);
  }
  assert.throws(() => parse({ telegram: { enabled: false, botTokenEnv: telegram.botToken } }), error => {
    assert.match(error.message, /use botToken/);
    assert.ok(!error.message.includes(telegram.botToken));
    return true;
  });
});
const finished = (text) => ({ type: "response.completed", message: { role: "assistant", content: [{ type: "text", text }] }, usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } });
async function fixture(t, model) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "maybeclaw-host-")));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup.reverse()) await close(); await rm(root, { recursive: true, force: true }); });
  const spec = { configPath: join(root, "config.json"), modelProfile: "fixture", modelFingerprint: digest("fixture"), runBudget: DEFAULT_TASK_BUDGET };
  const claw = new MaybeClaw({ directory: root, loadModel: () => model ?? { async *stream() { yield finished("Done"); } } });
  return { root, spec, claw, cleanup };
}
async function until(probe) { for (let i = 0; i < 150; i++) { const result = await probe(); if (result) return result; await delay(30); } throw new Error("Condition timed out"); }

test("loopback API authenticates, queues independently of clients, bounds concurrency and reopens without replay", async (t) => {
  let calls = 0, active = 0, peak = 0;
  const f = await fixture(t, { async *stream() {
    calls++; active++; peak = Math.max(peak, active);
    await delay(150); active--;
    yield finished('<script>alert("not HTML")</script>');
  } });
  const options = { claw: f.claw, selectSpec: async () => f.spec, maxConcurrent: 1, startPaused: true };
  let host = await MaybeClawHost.start(options);
  let server = await startControlServer({ host, token, port: 0 });
  f.cleanup.push(() => server.close());
  await assert.rejects(MaybeClawHost.start(options), /locked/);
  const request = (path, body, headers = {}) => fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await fetch(server.url + "/api/tasks")).status, 401);
  assert.equal((await request("/api/tasks", undefined, { origin: "https://attacker.invalid" })).status, 403);
  assert.equal(await new Promise((resolve, reject) => { const req = httpRequest(server.url + "/api/tasks", { headers: { host: "attacker.invalid", authorization: `Bearer ${token}` } }, res => { res.resume(); resolve(res.statusCode); }); req.on("error", reject); req.end(); }), 403);
  const page = await fetch(server.url);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /任务工作台/);
  assert.equal((await request("/api/tasks", { prompt: "hello", requestId: "bad", readDirectory: f.root })).status, 400);
  const first = await (await request("/api/tasks", { prompt: "first", requestId: "one" })).json();
  assert.equal(first.created, true);
  assert.equal((await (await request("/api/tasks", { prompt: "first", requestId: "one" })).json()).created, false);
  assert.equal((await request("/api/tasks", { prompt: "changed", requestId: "one" })).status, 400);
  await request("/api/tasks", { prompt: "second", requestId: "two" });
  // No client remains attached to either run.
  await until(async () => (await f.claw.store.list()).every(t => t.status === "completed"));
  assert.equal(calls, 2); assert.equal(peak, 1);
  assert.match((await f.claw.status(first.task.id)).task.result, /<script>/);
  const output = [];
  const previous = process.env.MAYBECLAW_TEST_CONTROL;
  process.env.MAYBECLAW_TEST_CONTROL = token;
  try {
    assert.equal(await runMaybeClaw(["task", "result", first.task.id, "--server", server.url, "--token-env", "MAYBECLAW_TEST_CONTROL"], { stdout: { write: text => output.push(text) } }), 0);
    assert.match(output.join(""), /unverified/);
  } finally { if (previous === undefined) delete process.env.MAYBECLAW_TEST_CONTROL; else process.env.MAYBECLAW_TEST_CONTROL = previous; }
  const interrupted = await (await request("/api/tasks", { prompt: "interrupt", requestId: "three" })).json();
  await request("/api/tasks", { prompt: "after restart", requestId: "four" });
  await until(async () => calls === 3 && (await f.claw.status(interrupted.task.id)).task.status === "running");
  await server.close();
  assert.equal((await f.claw.status(interrupted.task.id)).task.status, "cancelled");
  host = await MaybeClawHost.start(options);
  server = await startControlServer({ host, token, port: 0 });
  await until(async () => (await f.claw.store.list()).filter(t => t.status === "completed").length === 3);
  assert.equal(calls, 4);
  assert.equal((await host.claw.store.list()).length, 4);
});

test("channel inbox owns tasks, deduplicates events, and never replays unknown outbound attempts", async (t) => {
  const f = await fixture(t);
  let store = await ChannelStore.open(join(f.root, "channels.jsonl"));
  f.cleanup.push(() => store.close());
  const deliveries = [];
  const adapter = { name: "telegram", account: "telegram:42", allowUsers: ["7", "8"], status: () => "polling", run: async () => {},
    send: async d => { deliveries.push(d); if (d.text.includes("已接收")) throw new Error("Connection lost after the remote side accepted it"); } };
  const submit = (prompt, requestId) => f.claw.submit({ ...f.spec, prompt, requestId });
  let hub = new ChannelHub(store, [adapter], f.claw, submit);
  const input = { account: adapter.account, eventId: "100", sender: "7", conversation: "7", text: "summarize" };
  await hub.receive({ ...input, sender: "untrusted" });
  assert.equal(store.values().length, 0);
  await Promise.all([hub.receive(input), hub.receive(input)]);
  await hub.process();
  const task = (await f.claw.store.list())[0];
  assert.equal((await f.claw.store.list()).length, 1);
  await hub.receive({ ...input, eventId: "101", sender: "8", conversation: "8", text: `/cancel ${task.id}` });
  await hub.process();
  assert.equal((await f.claw.status(task.id)).cancellationRequested, false);
  await f.claw.run(task.id);
  await hub.process();
  await hub.deliver(new AbortController().signal);
  assert.equal(deliveries.length, 3);
  assert.ok(deliveries.some(d => d.text.includes("不属于")));
  assert.ok(deliveries.some(d => d.text.includes("Done")));
  assert.ok(store.values().some(d => d.kind === "delivery" && d.status === "unknown"));
  // Emulate a crash after durable sending intent, before recording the outcome.
  const final = store.values().find(d => d.kind === "delivery" && d.text.includes("Done"));
  await store.put({ ...final, status: "sending" });
  await store.close();
  store = await ChannelStore.open(join(f.root, "channels.jsonl"));
  hub = new ChannelHub(store, [adapter], f.claw, submit);
  await hub.receive(input); await hub.process(); await hub.deliver(new AbortController().signal);
  assert.equal(deliveries.length, 3);
  assert.equal(store.get(final.id).status, "unknown");
  await hub.receive({ ...input, eventId: "102", text: `/result ${task.id}` });
  await hub.process(); await hub.deliver(new AbortController().signal);
  assert.equal(deliveries.length, 4);
  // Permissions apply to pending output too, not only incoming events.
  await hub.receive({ ...input, eventId: "103", text: "/start" }); await hub.process();
  adapter.allowUsers.length = 0;
  await hub.deliver(new AbortController().signal);
  assert.equal(deliveries.length, 4);
  assert.ok(store.values().some(d => d.kind === "delivery" && d.status === "suppressed"));
});

test("Telegram transport advances its durable cursor after inbox persistence and does not override webhooks", async (t) => {
  const f = await fixture(t);
  const store = await ChannelStore.open(join(f.root, "channels.jsonl"));
  f.cleanup.push(() => store.close());
  const controller = new AbortController();
  const calls = [];
  const update = { update_id: 12, message: { message_id: 1, text: "hello", from: { id: 7, is_bot: false }, chat: { id: 7, type: "private" } } };
  assert.equal(telegramInput({ ...update, message: { ...update.message, chat: { id: -1, type: "group" } } }, "telegram:42"), undefined);
  const request = async (url, init) => {
    const method = String(url).split("/").at(-1), body = JSON.parse(init.body); calls.push({ method, body });
    let result = {};
    if (method === "getMe") result = { id: 42, is_bot: true };
    if (method === "getWebhookInfo") result = { url: "" };
    if (method === "getUpdates") {
      if (body.offset === 13) { assert.equal(store.get(inboxId(telegramInput(update, "telegram:42"))).kind, "inbox"); controller.abort(); throw new Error("Stopped"); }
      result = [update];
    }
    if (method === "sendMessage") result = { message_id: 9 };
    return Response.json({ ok: true, result });
  };
  const adapter = new TelegramAdapter({ enabled: true, botTokenEnv: "unused", allowUsers: ["7"] }, "42:fake-token", request);
  await adapter.run(input => store.put({ kind: "inbox", id: inboxId(input), input, processed: false }), store, controller.signal);
  assert.equal(store.get(cursorId(adapter.account)).offset, 13);
  await adapter.send({ conversation: "7", text: "plain <b>text</b>" }, new AbortController().signal);
  assert.equal(calls.at(-1).body.parse_mode, undefined);
  const conflict = new TelegramAdapter({ enabled: true, botTokenEnv: "unused", allowUsers: ["7"] }, "42:fake-token",
    async url => Response.json({ ok: true, result: String(url).endsWith("getMe") ? { id: 42, is_bot: true } : { url: "https://existing.invalid/hook" } }));
  await conflict.run(() => assert.fail("Unexpected receive"), store, new AbortController().signal);
  assert.equal(conflict.status(), "webhook-conflict");
  assert.doesNotMatch(await readFile(join(f.root, "channels.jsonl"), "utf8"), /fake-token/);
});

test("Feishu private-message normalization, credential isolation and single-attempt outbound protocol", async () => {
  const settings = { enabled: true, appId: "cli_0123456789abcdef", appSecretEnv: "FEISHU_SECRET", allowUsers: ["ou_user"] };
  assert.throws(() => hostSettings({ apps: { maybeclaw: { channels: { feishu: { ...settings, allowUsers: [] } } } } }), /allowUsers/);
  assert.throws(() => hostSettings({ apps: { maybeclaw: { channels: { telegram: { enabled: true, allowUsers: ["7"], allowGroups: true } } } } }), /Invalid/);
  const event = { sender: { sender_type: "user", sender_id: { open_id: "ou_user" } }, message: { chat_type: "p2p", chat_id: "oc_chat", message_id: "om_message", message_type: "text", content: JSON.stringify({ text: "hello" }) } };
  const input = feishuInput(event, `feishu:${settings.appId}`);
  assert.equal(input.sender, "ou_user");
  assert.equal(feishuInput({ ...event, message: { ...event.message, chat_type: "group" } }, input.account), undefined);
  const calls = [];
  const adapter = new FeishuAdapter(settings, "fake-app-secret", async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    return Response.json(calls.length === 1 ? { code: 0, tenant_access_token: "fake-tenant-token" } : { code: 0, data: { message_id: "om_reply" } });
  });
  const delivery = { id: digest("outbound"), conversation: "oc_chat", text: "你好 <script>" };
  await adapter.send(delivery, new AbortController().signal);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.app_secret, "fake-app-secret");
  assert.equal(calls[1].headers.authorization, "Bearer fake-tenant-token");
  assert.equal(calls[1].body.uuid.length, 32);
  assert.equal(JSON.parse(calls[1].body.content).text, delivery.text);
  assert.equal(calls[1].body.msg_type, "text");
  let attempts = 0;
  const failed = new FeishuAdapter(settings, "fake", async () => { attempts++; throw new Error("Timeout"); });
  await assert.rejects(failed.send(delivery, new AbortController().signal));
  assert.equal(attempts, 1);
});
