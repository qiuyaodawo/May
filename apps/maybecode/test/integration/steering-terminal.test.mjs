import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { NodeTerminalDriver } from "@may/tui";
import { loadMayConfig } from "@may/config";
import { createNodeTerminal, openConfiguredMaybeCode, runRetainedTerminalUI, runTerminalUI } from "../../dist/index.js";

const base = fileURLToPath(new URL("../../../../.zcode/tmp/maybecode-steering-terminal/", import.meta.url));
async function until(probe) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) { const result = await probe(); if (result) return result; await delay(20); }
  throw new Error("终端输入验证等待超时");
}

for (const retained of [false, true]) test(`真实 ${retained ? "retained" : "classic"} 终端在执行期间接收补充消息、替换输入和${retained ? "Ctrl+C" : "/stop"}`, {
  skip: !process.env.MAYBECODE_STEER_LIVE_MODEL, timeout: 180_000,
}, async t => {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const workspace = join(directory, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "input.txt"), "Terminal steering verification file.\n");
  const config = await loadMayConfig();
  const app = await openConfiguredMaybeCode({ git: false, workspace, dataDirectory: join(directory, "data"), configPath: config.path,
    model: process.env.MAYBECODE_STEER_LIVE_MODEL, autoResume: false, goals: false, mcp: false, observability: false, skills: false, retry: false,
    runBudget: { maxSteps: 6, maxModelCalls: 6, maxToolCalls: 6, maxDurationMs: 90_000 } });
  const input = new PassThrough(), output = new PassThrough();
  let rendered = "";
  output.on("data", chunk => { rendered += chunk.toString(); });
  const terminal = retained ? new NodeTerminalDriver({ input, output, requireTTY: false }) : createNodeTerminal({ input, output });
  const ui = retained ? runRetainedTerminalUI(app, { terminal }) : runTerminalUI(app, { terminal });
  let finished = false;
  t.after(async () => {
    if (!finished) {
      app.cancel("Terminal verification cleanup");
      await until(() => !app.isRunning);
      input.write(retained ? "\u0003" : "/quit\r\n");
    }
    try { await ui; }
    finally { terminal.close(); input.destroy(); output.destroy(); await app.close(); }
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  await until(() => rendered.includes("MaybeCode"));
  input.write("Use read to inspect input.txt, then reply ORIGINAL_RESPONSE. Do not use shell or modify files.\r\n");
  await until(() => app.isRunning);
  input.write("/steer After reading, reply exactly TERMINAL_STEERING_CONFIRMED.\r\n");
  await until(() => app.listSteeringInputs().length === 1);
  await until(() => !app.isRunning && app.listSteeringInputs()[0].status === "delivered");
  let history = await app.history();
  assert.ok(history.some(event => event.type === "assistant.completed" && event.message.content.some(part => part.type === "text" && part.text.includes("TERMINAL_STEERING_CONFIRMED"))));

  input.write("/steer Do not use tools. Reply exactly TERMINAL_IDLE_STEERING_CONFIRMED.\r\n");
  await until(() => app.isRunning);
  const idleOutputStart = rendered.length;
  await until(() => !app.isRunning && app.listSteeringInputs().length === 2 && app.listSteeringInputs()[1].status === "delivered");
  history = await app.history();
  assert.ok(history.some(event => event.type === "assistant.completed" && event.message.content.some(part => part.type === "text" && part.text.includes("TERMINAL_IDLE_STEERING_CONFIRMED"))));
  if (retained) await until(() => rendered.slice(idleOutputStart).includes("Ready"));

  const cancelled = history.filter(event => event.type === "run.cancelled").length;
  const runsBeforeReplacement = history.filter(event => event.type === "run.started").length;
  input.write("Use read to inspect input.txt, then explain every word in detail. Do not use shell or modify files.\r\n");
  await until(async () => app.isRunning && (await app.history()).filter(event => event.type === "run.started").length > runsBeforeReplacement);
  input.write("Do not use tools. Reply exactly TERMINAL_REPLACEMENT_CONFIRMED.\r\n");
  await until(async () => (await app.history()).some(event => event.type === "input.submitted" && event.message.content.some(part => part.type === "text" && part.text.includes("TERMINAL_REPLACEMENT_CONFIRMED"))));
  await until(() => !app.isRunning);
  history = await app.history();
  assert.ok(history.filter(event => event.type === "run.cancelled").length > cancelled);
  assert.ok(history.some(event => event.type === "assistant.completed" && event.message.content.some(part => part.type === "text" && part.text.includes("TERMINAL_REPLACEMENT_CONFIRMED"))));

  const beforeInterrupt = history.filter(event => event.type === "run.cancelled").length;
  const runsBeforeInterrupt = history.filter(event => event.type === "run.started").length;
  input.write("Use read to inspect input.txt, then explain every word in detail.\r\n");
  await until(async () => app.isRunning && (await app.history()).filter(event => event.type === "run.started").length > runsBeforeInterrupt);
  input.write(retained ? "TERMINAL_CANCEL_PENDING_FIRST\rTERMINAL_CANCEL_PENDING_SECOND\r\u0003" : "/stop\r\n");
  await until(() => !app.isRunning);
  history = await app.history();
  assert.ok(history.filter(event => event.type === "run.cancelled").length > beforeInterrupt);
  assert.ok(!history.some(event => event.type === "input.submitted" && event.message.content.some(part => part.type === "text" && part.text.includes("TERMINAL_CANCEL_PENDING_"))));
  input.write("/quit\r\n");
  await ui;
  finished = true;
});
