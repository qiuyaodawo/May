import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadMayConfig } from "@may/config";
import { AgentApplication } from "@may/application";
import { InMemoryContext, May } from "@may/core";
import { Session } from "@may/session";
import { FileSessionStore } from "@may/session/file-store";
import { createMaybeCodeModel, selectMaybeCodeModel, openConfiguredMaybeCode, startMaybeCodeWebUI } from "../../dist/index.js";

test("real Session and AgentApplication reject custom input sources without changing history and remain usable", {
  skip: !process.env.MAYBECODE_LIVE_MODEL, timeout: 120_000,
}, async () => {
  const base = resolve(import.meta.dirname, "../../../../.zcode/tmp/maybecode-input-options");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const model = createMaybeCodeModel(selectMaybeCodeModel(await loadMayConfig(), { model: process.env.MAYBECODE_LIVE_MODEL }));
  const session = await Session.create({ runtime: new May({ model, context: new InMemoryContext() }), store: new FileSessionStore(join(directory, "session")) });
  const app = await AgentApplication.open({ model, store: new FileSessionStore(join(directory, "application")), permissionPolicy: () => "deny" });
  try {
    for (const target of [session, app]) {
      const before = await target.history();
      for (const options of [{ stepInputSource: () => [] }, { stepInputSource: null }]) {
        for (const operation of [
          () => target.submit({ ...options, input: "Rejected input" }),
          () => target.continue(options),
          () => target.startSteeringInput("missing-input", options),
        ]) assert.throws(operation, error => error instanceof TypeError && /through steer\(\).*stepInputSource/.test(error.message));
      }
      assert.deepEqual(await target.history(), before);
      assert.deepEqual(target.listSteeringInputs(), []);
      const runBudget = { maxSteps: 2, maxModelCalls: 2, maxDurationMs: 60000 };
      const run = await target.submit({ input: "Reply exactly INPUT_OPTIONS_CONFIRMED. Repeat that response if asked to continue.", runBudget });
      assert.match(JSON.stringify((await run.result).message), /INPUT_OPTIONS_CONFIRMED/);
      const continued = await target.continue({ runBudget });
      await continued.result;
      const history = await target.history();
      assert.equal(history.filter(event => event.type === "input.submitted").length, 1);
      assert.equal(history.filter(event => event.type === "run.completed").length, 2);
    }
  } finally {
    await app.close();
    assert.ok(resolve(directory).startsWith(base + sep)); await rm(directory, { recursive: true, force: true });
  }
});

test("real model and Web input preserve Step steering, interrupt ordinary work, and cancel undelivered input", {
  skip: !process.env.MAYBECODE_LIVE_MODEL, timeout: 180_000,
}, async () => {
  const base = resolve(import.meta.dirname, "../../../../.zcode/tmp/maybecode-steering");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-")), workspace = join(directory, "project");
  await mkdir(workspace);
  const app = await openConfiguredMaybeCode({ workspace, dataDirectory: join(directory, "state"), model: process.env.MAYBECODE_LIVE_MODEL,
    permissionMode: "default", goals: false, skills: false, mcp: false, retry: false, observability: false,
    instructions: "Follow explicit user requests exactly. Use write for file creation. Do not run shell commands. Keep final answers short.",
    runBudget: { maxSteps: 8, maxModelCalls: 8, maxToolCalls: 8, maxDurationMs: 120000 } });
  const token = randomBytes(32).toString("base64url"), server = await startMaybeCodeWebUI(app, { token, port: 0 });
  async function snapshot() { const response = await fetch(`${server.url}/api/ui/snapshot`, { headers: { authorization: `Bearer ${token}` } }); assert.equal(response.status, 200); return response.json(); }
  async function command(name, args) {
    const state = await snapshot();
    const response = await fetch(`${server.url}/api/ui/commands`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ version: 1, hostId: state.hostId, targetId: state.activeId, requestId: crypto.randomUUID(), name, args }) });
    const receipt = await response.json(); assert.equal(response.status, 200, receipt.error); return receipt;
  }
  async function until(check) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await delay(30); }
    throw new Error("Expected MaybeCode state was not reached");
  }
  const approval = () => until(async () => (await snapshot()).interactions.find(item => item.kind === "approval"));
  try {
    const queued = app.submit({ input: "Do not execute this cancelled queued request." });
    const cancelledQueue = assert.rejects(queued, error => error.code === "RUN_CANCELLED");
    assert.equal(app.cancel("Cancel queued input"), true);
    await cancelledQueue;
    assert.equal((await app.history()).filter(event => event.type === "input.submitted").length, 0);

    const queuedSteering = app.steer({ input: "Do not execute this cancelled queued steering input." });
    const cancelledSteering = assert.rejects(queuedSteering, error => error.code === "RUN_CANCELLED");
    assert.equal(app.cancel("Cancel queued steering"), true);
    await cancelledSteering;
    assert.equal(app.listSteeringInputs().length, 0);

    const run = await app.submit({ input: "Use write to create first.txt containing FIRST. Then report completion." });
    const pending = await approval();
    await command("console.execute", { text: "/steer After writing the file, reply exactly STEERING_CONFIRMED." });
    assert.equal(app.listSteeringInputs()[0].status, "pending");
    assert.equal(app.isRunning, true);
    await command("approval.resolve", { id: pending.id, decision: "allow" });
    assert.match(JSON.stringify((await run.result).message), /STEERING_CONFIRMED/);
    assert.equal((await readFile(join(workspace, "first.txt"), "utf8")).trim(), "FIRST");
    assert.equal(app.listSteeringInputs()[0].status, "delivered");
    const steeredBlocks = (await snapshot()).blocks.filter(block => block.kind === "user" && block.text === "After writing the file, reply exactly STEERING_CONFIRMED.");
    assert.equal(steeredBlocks.length, 1);
    assert.equal(steeredBlocks[0].runId, run.id);
    const events = await app.history();
    assert.ok(events.findIndex(event => event.type === "input.steering.delivered") > events.findIndex(event => event.type === "tool.completed"));

    const interrupted = await app.submit({ input: "Use write to create interrupted.txt containing SHOULD_NOT_BE_WRITTEN." });
    await approval();
    const rejected = assert.rejects(interrupted.result, error => error.code === "RUN_CANCELLED");
    await command("message.submit", { text: "Cancel the previous file request. Do not use tools. Reply exactly NEW_INPUT_CONFIRMED." });
    await rejected; await until(() => !app.isRunning);
    assert.match(JSON.stringify(await app.history()), /NEW_INPUT_CONFIRMED/);
    await assert.rejects(readFile(join(workspace, "interrupted.txt")), error => error.code === "ENOENT");

    const stopped = await app.submit({ input: "Use write to create stopped.txt containing SHOULD_NOT_BE_WRITTEN." });
    await approval();
    await command("console.execute", { text: "/steer This pending input must remain undelivered after stop." });
    const stoppedResult = assert.rejects(stopped.result, error => error.code === "RUN_CANCELLED");
    await command("console.execute", { text: "/stop" });
    await stoppedResult; await until(() => !app.isRunning);
    assert.equal(app.listSteeringInputs().at(-1).status, "cancelled");
    await assert.rejects(readFile(join(workspace, "stopped.txt")), error => error.code === "ENOENT");

    await command("console.execute", { text: "/steer Reply exactly IDLE_STEERING_CONFIRMED without tools." });
    await until(() => !app.isRunning);
    assert.equal(app.listSteeringInputs().at(-1).status, "delivered");
    assert.match(JSON.stringify(await app.history()), /IDLE_STEERING_CONFIRMED/);
  } finally {
    await server.close();
    assert.ok(resolve(directory).startsWith(base + sep)); await rm(directory, { recursive: true, force: true });
  }
});
