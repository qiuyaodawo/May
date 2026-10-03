import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PluginHost } from "@may/plugin";
import { createAgentAdaptersPlugin, agentAdapterRegistryService, createGatewayRpcAdapter } from "../dist/index.js";

const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
async function directory(t) {
  const base = fileURLToPath(new URL("../../../../plugin-verification/agent-adapters/", import.meta.url));
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "files-"));
  t.after(() => { assert.ok(resolve(path).startsWith(resolve(base) + sep)); return rm(path, { recursive: true, force: true }); }); return path;
}
function rpcOptions(path) { return { transport: "stdio", command: process.execPath, args: [example, "--directory", join(path, "state"), "--workspace", path] }; }
const context = (conversationId, inputId, path) => ({ conversationId, inputId, input: { role: "user", content: [{ type: "text", text: JSON.stringify({ operation: "sha256", path }) }] }, signal: new AbortController().signal, tools: [], shouldYield: () => false, report(event) { throw new Error(`File hash service does not emit application event ${event.type}`); } });
const pidOf = async (adapter, conversation) => JSON.parse(await adapter.command(conversation, "process", [])).pid;
const assertProcessClosed = pid => assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");

test("registry owns actual RPC file computations and lazily recreates released processes", async t => {
  const path = await directory(t), text = "Managed file computation";
  await writeFile(join(path, "document.txt"), text);
  let creations = 0;
  const factories = { files: () => { creations += 1; return createGatewayRpcAdapter("files", rpcOptions(path)); } };
  const host = await PluginHost.create({ plugins: [createAgentAdaptersPlugin({ factories: () => factories })] });
  t.after(() => host.close());
  const registry = host.get(agentAdapterRegistryService);
  assert.equal(creations, 0);
  const [first, shared] = await Promise.all([registry.get("files"), registry.get("files")]);
  assert.equal(first, shared); assert.equal(creations, 1);
  const conversation = await first.createConversation("document-request"), pid = await pidOf(first, conversation);
  assert.equal((await first.execute(context(conversation, "document-hash", "document.txt"))).text, createHash("sha256").update(text).digest("hex"));
  await registry.release("files"); assertProcessClosed(pid);
  const second = await registry.get("files");
  assert.notEqual(first, second); assert.equal(creations, 2);
  assert.equal((await second.inspect(conversation, "document-hash")).status, "completed");
  const secondPid = await pidOf(second, conversation);
  await Promise.all([registry.release("files"), host.close()]); assertProcessClosed(secondPid);
});

test("registry creation failure remains retryable after a real subprocess startup error", async t => {
  const path = await directory(t);
  let options = { ...rpcOptions(path), args: [join(path, "missing-agent.mjs")] };
  const host = await PluginHost.create({ plugins: [createAgentAdaptersPlugin({ factories: () => ({ files: () => createGatewayRpcAdapter("files", options) }) })] });
  t.after(() => host.close());
  const registry = host.get(agentAdapterRegistryService);
  await assert.rejects(registry.get("files"));
  options = rpcOptions(path);
  const adapter = await registry.get("files"), conversation = await adapter.createConversation("after-repair");
  assert.equal((await adapter.inspectCreation("after-repair")).conversationId, conversation);
  await host.close();
});

test("plugin closing waits for in-flight creation and releases the real child before completion", async t => {
  const path = await directory(t);
  let completeCreation, announce;
  const gate = new Promise(resolve => { completeCreation = resolve; });
  const opened = new Promise(resolve => { announce = resolve; });
  const host = await PluginHost.create({ plugins: [createAgentAdaptersPlugin({ factories: { files: async () => {
    const adapter = await createGatewayRpcAdapter("files", rpcOptions(path));
    const conversation = await adapter.createConversation("during-close");
    announce(await pidOf(adapter, conversation)); await gate; return adapter;
  } } })] });
  t.after(async () => { completeCreation(); await host.close(); });
  const starting = host.get(agentAdapterRegistryService).get("files"), rejected = assert.rejects(starting);
  const pid = await opened;
  let completed = false;
  const closing = host.close().then(() => { completed = true; });
  await setImmediate();
  assert.equal(completed, false); process.kill(pid, 0);
  completeCreation(); await Promise.all([closing, rejected]); assertProcessClosed(pid);
});

test("RPC state queries and steering serialize with cancellation and preserve saved inputs", async t => {
  const path = await directory(t), options = rpcOptions(path);
  let adapter = await createGatewayRpcAdapter("files", options);
  t.after(() => adapter.close());
  const conversation = await adapter.createConversation("concurrent-state");
  const work = adapter.execute({ ...context(conversation, "waiting", "arrival.txt"), input: {
    role: "user", content: [{ type: "text", text: JSON.stringify({ operation: "waitForFile", path: "arrival.txt" }) }],
  } });
  const rejected = assert.rejects(work, /Cancelled by Gateway/);
  const deadline = Date.now() + 10_000;
  while ((await adapter.inspect(conversation, "waiting")).status !== "running") {
    assert.ok(Date.now() < deadline, "File wait did not start"); await delay(10);
  }
  const pending = Array.from({ length: 32 }, (_, index) => Promise.all([
    adapter.steer(conversation, `Read saved input ${index}`, `follow-up-${index}`),
    adapter.steeringInputs(conversation),
    adapter.command(conversation, "status", []),
    adapter.inspect(conversation, "waiting"),
  ]));
  await adapter.cancel(conversation);
  await Promise.all([...pending, rejected]);
  assert.equal((await adapter.inspect(conversation, "waiting")).status, "cancelled");
  const saved = await adapter.steeringInputs(conversation);
  assert.equal(saved.length, 32);
  assert.ok(saved.every(item => item.status === "cancelled" || item.status === "idle"));
  await adapter.close();
  adapter = await createGatewayRpcAdapter("files", options);
  assert.deepEqual(await adapter.steeringInputs(conversation), saved);
});
