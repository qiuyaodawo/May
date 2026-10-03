import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadMayConfig } from "@may/config";
import { userMessage } from "@may/core";
import { definePlugin, defineService } from "@may/plugin";
import { createModelPlugin } from "@may/plugin-models";
import { createPermissionPlugin } from "@may/plugin-permissions";
import { services } from "@may/plugin-services";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { loadGatewayAdapter } from "../../dist/gateway-adapters.js";

const base = fileURLToPath(new URL("../../../../plugin-verification/maybeclaw-plugin-live/", import.meta.url));
const liveOptions = { skip: !process.env.MAYBECLAW_LIVE_MODEL, timeout: 120_000 };
async function directory() {
  await mkdir(base, { recursive: true });
  const value = await mkdtemp(join(base, "case-"));
  return value;
}
async function cleanup(path, adapter) {
  await adapter?.close();
  assert.ok(resolve(path).startsWith(resolve(base) + sep));
  await rm(path, { recursive: true, force: true });
}
function input(conversationId, inputId, text, events) {
  return { conversationId, inputId, input: userMessage(text), tools: [],
    signal: new AbortController().signal, shouldYield: () => false, report: event => events.push(event) };
}
const budget = { maxSteps: 5, maxModelCalls: 5, maxToolCalls: 4, maxDurationMs: 90_000 };

test("real provider: supplied Model and Permission plugins create and resume without provider configuration", liveOptions, async t => {
  const configured = await loadMayConfig();
  const model = createBuiltinProviderModel(selectProviderModel(configured, { model: process.env.MAYBECLAW_LIVE_MODEL }));
  const path = await directory(), configPath = join(path, "config.json"), marker = `plugin-memory-${randomUUID()}`;
  let adapter;
  t.after(() => cleanup(path, adapter));
  await writeFile(configPath, JSON.stringify({ providers: {}, models: {}, apps: { maybeclaw: { version: 2, agents: [] } } }));
  await writeFile(join(path, "note.txt"), marker);
  const checks = [], disposed = [];
  const policy = check => {
    assert.ok(Object.isFrozen(check.input)); checks.push(check.tool.name);
    return check.tool.name === "read" ? "allow" : "deny";
  };
  const plugins = [
    createModelPlugin({ id: "verification.model", create: () => model, dispose: () => { disposed.push("model"); } }),
    createPermissionPlugin({ id: "verification.permissions", create: () => policy, dispose: () => { disposed.push("permissions"); } }),
  ];
  const options = { directory: path, configPath, plugins, agent: { id: "plugin-reader", adapter: "may",
    readDirectory: path, permissions: { read: "deny" }, runBudget: budget,
    instructions: "Use read exactly when requested. Preserve values from earlier messages. Keep replies short." } };
  adapter = await loadGatewayAdapter(options);
  const conversation = await adapter.createConversation("plugin-conversation"), events = [];
  const first = await adapter.execute(input(conversation, "read-note", "Use read to read note.txt. You must call the tool. Remember the exact value and reply only with that value.", events));
  assert.ok(first.text.includes(marker));
  assert.ok(checks.includes("read"));
  const read = events.find(event => event.type === "run.event" && event.event.type === "tool.completed" && event.event.call.name === "read");
  assert.ok(read); assert.ok(read.event.output.content.includes(marker));
  assert.equal(events.some(event => event.type === "permission.event" && event.event.type === "approval.requested"), false);
  assert.equal((await adapter.inspect(conversation, "read-note")).status, "completed");
  await adapter.close();
  assert.deepEqual(new Set(disposed), new Set(["model", "permissions"]));
  adapter = await loadGatewayAdapter(options);
  assert.deepEqual(await adapter.inspectCreation("plugin-conversation"), { status: "ready", conversationId: conversation });
  assert.equal(await adapter.createConversation("plugin-conversation"), conversation);
  const restored = await adapter.execute(input(conversation, "recall-note", "What exact value did I ask you to remember? Do not use tools. Reply only with that value.", []));
  assert.ok(restored.text.includes(marker));
  await adapter.close();
  assert.equal(disposed.filter(item => item === "model").length, 2);
  assert.equal(disposed.filter(item => item === "permissions").length, 2);
  const stored = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(stored.providers, {}); assert.deepEqual(stored.models, {});
  assert.equal(stored.defaultModel, undefined);
});

test("real provider: host services sharing IDs retain application default providers across resume", liveOptions, async t => {
  const configured = await loadMayConfig(), path = await directory(), marker = `scope-memory-${randomUUID()}`;
  let adapter;
  t.after(() => cleanup(path, adapter));
  const model = createBuiltinProviderModel(selectProviderModel(configured, { model: process.env.MAYBECLAW_LIVE_MODEL }));
  const hostModel = defineService({ id: services.model.id, version: services.model.version, scope: "host" });
  const hostPolicy = defineService({ id: services.permissionPolicy.id, version: services.permissionPolicy.version, scope: "host" });
  await writeFile(join(path, "note.txt"), marker);
  let hostChecks = 0, opened = 0, closed = 0;
  const plugin = definePlugin({ id: "verification.host-services", version: "1.0.0", scope: "host", provides: [hostModel, hostPolicy], async setup(context) {
    const handle = await open(join(path, "note.txt"), "r"); opened += 1;
    context.defer(async () => { await handle.close(); closed += 1; });
    context.provide(hostModel, model);
    context.provide(hostPolicy, () => { hostChecks += 1; return "deny"; });
  } });
  const options = { directory: path, configPath: configured.path, plugins: [plugin], agent: { id: "scope-reader", adapter: "may",
    model: process.env.MAYBECLAW_LIVE_MODEL, readDirectory: path, runBudget: budget,
    instructions: "Use read exactly when requested. Preserve values from earlier messages. Keep replies short." } };
  adapter = await loadGatewayAdapter(options);
  const conversation = await adapter.createConversation("scope-conversation"), events = [];
  const first = await adapter.execute(input(conversation, "read-note", "Use read to read note.txt. You must call the tool. Remember the exact value and reply only with that value.", events));
  assert.ok(first.text.includes(marker));
  const read = events.find(event => event.type === "run.event" && event.event.type === "tool.completed" && event.event.call.name === "read");
  assert.ok(read); assert.ok(read.event.output.content.includes(marker));
  assert.equal(events.some(event => event.type === "permission.event" && event.event.type === "approval.requested"), false);
  assert.equal(hostChecks, 0);
  await adapter.close(); assert.equal(opened, closed);
  adapter = await loadGatewayAdapter(options);
  assert.equal(await adapter.createConversation("scope-conversation"), conversation);
  const restored = await adapter.execute(input(conversation, "recall-note", "What exact value did I ask you to remember? Do not use tools. Reply only with that value.", []));
  assert.ok(restored.text.includes(marker));
  await adapter.close(); assert.equal(opened, 2); assert.equal(closed, 2); assert.equal(hostChecks, 0);
});
