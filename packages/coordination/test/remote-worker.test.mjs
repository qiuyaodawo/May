import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { CoordinationRuntime, InMemoryCoordinationStore } from "../dist/index.js";
import { createRemoteAgent } from "../dist/remote-worker.js";

const token = "offline-test-token-with-at-least-24-characters";
const policy = { version: "v1", authorize: () => true };
async function directory(t) {
  const parent = resolve(tmpdir()), path = await mkdtemp(join(parent, "may-remote-"));
  const part = relative(parent, path); assert.ok(!isAbsolute(part) && !part.startsWith("..") && part.startsWith("may-remote-"));
  t.after(() => rm(path, { recursive: true, force: true })); return path;
}
async function start(path) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("fixtures/remote-worker.mjs", import.meta.url)), path], {
    env: { ...process.env, MAY_TEST_WORKER_TOKEN: token }, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true,
  });
  let stderr = ""; child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  const ended = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const port = await new Promise((resolve, reject) => {
    child.once("message", ({ port }) => resolve(port)); child.once("error", reject);
    child.once("exit", () => reject(new Error(`Worker exited before ready: ${stderr}`)));
  });
  return { url: `http://127.0.0.1:${port}`, async close() {
    if (child.connected) child.send("close"); assert.equal(await ended, 0, stderr);
  } };
}
function remote(url) { return createRemoteAgent({ url, token, agent: "worker", version: "v1", pollIntervalMs: 10 }); }

test("separate worker process enforces authority and recovers durable results without duplicate execution", async (t) => {
  const path = await directory(t), worker = await start(path), store = new InMemoryCoordinationStore();
  t.after(() => worker.close());
  assert.throws(() => createRemoteAgent({ url: "http://example.com", token, agent: "worker", version: "v1" }), /HTTPS/);
  const unauthorized = await fetch(`${worker.url}/v1/recover`, { method: "POST", headers: { authorization: "Bearer bad" }, body: "{}" });
  assert.equal(unauthorized.status, 401);
  const runtime = await CoordinationRuntime.create({ id: "distributed", store, policy, agents: { remote: remote(worker.url) },
    tasks: ["a", "b"].map((id) => ({ id, agent: "remote", input: id })), limits: { maxConcurrent: 2 },
  });
  const state = await runtime.wait(); assert.deepEqual(state.tasks.map((task) => task.output?.text), ["Remote: a", "Remote: b"]);
  const execution = { coordinationId: state.id, task: state.tasks[0], dependencies: [], messages: [] };
  const again = await remote(worker.url).execute(execution, { signal: new AbortController().signal, report() {} });
  assert.equal(again.text, "Remote: a");
  const conflict = await fetch(`${worker.url}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ agent: "worker", execution: { ...execution, task: { ...execution.task, input: "changed" } } }),
  });
  assert.equal(conflict.status, 400);
  await runtime.close(); await worker.close();
  const reopened = await start(path);
  t.after(() => reopened.close());
  const outcome = await remote(reopened.url).recover(execution); assert.equal(outcome.status, "completed");
  await reopened.close();
  assert.deepEqual((await readFile(join(path, "calls.log"), "utf8")).trim().split("\n"), ["a", "b"]);
});

test("lost remote acceptance response blocks uncertain work, then reconciles without resending", async (t) => {
  const path = await directory(t), worker = await start(path); let dropped = false;
  t.after(() => worker.close());
  const proxy = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const upstream = await fetch(`${worker.url}${request.url}`, { method: request.method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(request.method === "GET" ? {} : { body: Buffer.concat(chunks) }),
      });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!dropped && request.url === "/v1/jobs") { dropped = true; response.destroy(); return; }
      response.writeHead(upstream.status, { "content-type": "application/json" }); response.end(bytes);
    } catch { response.destroy(); }
  });
  await new Promise((done) => proxy.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => proxy.close(done)));
  const options = { id: "lost-response", store: new InMemoryCoordinationStore(), policy,
    agents: { remote: remote(`http://127.0.0.1:${proxy.address().port}`) },
  };
  const runtime = await CoordinationRuntime.create({ ...options, tasks: [{ id: "slow", agent: "remote", input: "slow" }] });
  assert.equal((await runtime.wait()).tasks[0].status, "recovery-required");
  await setTimeout(300);
  await runtime.close();
  const resumed = await CoordinationRuntime.resume(options);
  assert.equal((await resumed.wait()).tasks[0].output.text, "Remote: slow"); await resumed.close();
  assert.equal(dropped, true); assert.equal((await readFile(join(path, "calls.log"), "utf8")).trim(), "slow");
  await new Promise((done) => proxy.close(done)); await worker.close();
});

test("worker rejects unauthorized task input without creating executable work", async (t) => {
  const path = await directory(t), worker = await start(path);
  t.after(() => worker.close());
  const agent = remote(worker.url), execution = { coordinationId: "denied", dependencies: [], messages: [], task: {
    id: "denied", agent: "remote", input: "denied", turn: 0, dependsOn: [], status: "running", agentVersion: "v1", dispatchId: randomUUID(), sessionId: randomUUID(),
  } };
  await assert.rejects(agent.execute(execution, { signal: new AbortController().signal, report() {} }), /403/);
  assert.equal((await agent.recover(execution)).status, "recovery-required");
  await worker.close(); await assert.rejects(readFile(join(path, "calls.log")), /ENOENT/);
});

test("queued remote ownership and cancellation tombstones prevent delayed dispatch from executing", async (t) => {
  const path = await directory(t), worker = await start(path), agent = remote(worker.url);
  t.after(() => worker.close());
  const execution = (id) => ({ coordinationId: "cancel-race", dependencies: [], messages: [], task: {
    id, agent: "remote", input: id, turn: 0, dependsOn: [], status: "running", agentVersion: "v1", dispatchId: randomUUID(), sessionId: randomUUID(),
  } });
  const send = async (task) => {
    const result = await fetch(`${worker.url}/v1/jobs`, { method: "POST", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent: "worker", execution: task }),
    });
    assert.equal(result.status, 200); return result.json();
  };
  const blocked = execution("blocked"), queued = execution("queued"), late = execution("late");
  await send(blocked); assert.equal((await send(queued)).status, "queued");
  assert.equal((await agent.recover(queued)).status, "recovery-required");
  await agent.cancel(queued);
  assert.equal((await agent.recover(queued)).status, "cancelled");
  await agent.cancel(late);
  assert.equal((await send(late)).outcome.status, "cancelled");
  await agent.cancel(blocked); await worker.close();
  const calls = await readFile(join(path, "calls.log"), "utf8").catch(() => "");
  assert.ok(!calls.includes("queued") && !calls.includes("late"));
});
