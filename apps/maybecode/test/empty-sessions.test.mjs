import assert from "node:assert/strict";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { NodeTerminalDriver } from "@sortedyuan/tui";
import { OpenAIResponsesModel } from "@sortedyuan/providers";
import { openConfiguredMaybeCode, runMaybeCode } from "../dist/index.js";
import { runRetainedTerminalUI } from "../dist/ui/retained-tui.js";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { FileSessionCatalog } from "@sortedyuan/may/session/catalog";
import { MaybeCodeApplication } from "../dist/application.js";
import { MaybeCodeWorkspace } from "../dist/workspace.js";
import { createTestWorkspace } from "./fixtures/workspace.mjs";

test("CLI 在 retained 界面通过 /quit 退出后清理历史文件和会话目录", async t => {
  const workspace = await createTestWorkspace(t);
  const dataDirectory = join(workspace, "data");
  const configPath = join(workspace, "may.json");
  await writeFile(configPath, JSON.stringify({
    providers: { local: { adapter: "openai-responses", apiKey: "unused-without-model-requests" } },
    defaultModel: "offline",
    models: { offline: { provider: "local", model: "gpt-4.1" } },
    apps: { maybecode: { git: false } },
  }));
  const input = new PassThrough(), output = new PassThrough();
  let rendered = "";
  output.on("data", chunk => { rendered += chunk.toString(); });
  const terminal = new NodeTerminalDriver({ input, output, requireTTY: false });
  t.after(() => { terminal.close(); input.destroy(); output.destroy(); });
  const exitCode = runMaybeCode(["--config", configPath, workspace], {
    open: options => openConfiguredMaybeCode({ ...options, dataDirectory }),
    runRetainedUI: app => runRetainedTerminalUI(app, { terminal }),
  });
  while (!rendered.includes("MaybeCode")) await delay(20);
  input.write("/quit\r");
  assert.equal(await exitCode, 0);
  assert.deepEqual((await readdir(join(dataDirectory, "sessions"))).filter(name => name.endsWith(".jsonl")), []);
  assert.deepEqual(await new FileSessionCatalog(join(dataDirectory, "catalog.json")).list(workspace), []);
});

async function storageOptions(t) {
  const workspace = await createTestWorkspace(t);
  return {
    workspace,
    git: false,
    subagents: false,
    skills: false,
    goals: false,
    model: new OpenAIResponsesModel({
      apiKey: "unused-local-storage-test",
      model: "gpt-4.1",
      baseURL: "invalid-url",
    }),
    modelInfo: { provider: "openai", model: "gpt-4.1" },
    store: new FileSessionStore(join(workspace, ".sessions")),
    catalog: new FileSessionCatalog(join(workspace, "catalog.json")),
  };
}

test("退出后删除新建空会话，重新启动后会话列表不再包含它", async t => {
  const options = await storageOptions(t);
  const app = await MaybeCodeWorkspace.open(options);
  const sessionId = app.sessionId;
  assert.ok((await app.history()).some(event => event.type === "state.updated"));
  assert.ok((await app.listSessions()).some(session => session.id === sessionId));
  await Promise.all([app.close(), app.close()]);

  const reopened = await MaybeCodeWorkspace.open({
    ...options,
    store: new FileSessionStore(options.store.directory),
    catalog: new FileSessionCatalog(options.catalog.path),
  });
  try {
    assert.deepEqual(await options.store.inspect(sessionId), []);
    assert.equal((await reopened.listSessions()).some(session => session.id === sessionId), false);
  } finally {
    await reopened.close();
  }
});

test("退出时清理本次运行通过 newSession 创建的全部空会话", async t => {
  const options = await storageOptions(t);
  const app = await MaybeCodeWorkspace.open(options);
  const first = app.sessionId;
  const second = await app.newSession();
  await app.renameSession(second, "Empty session");
  await app.close();
  assert.deepEqual(await options.store.inspect(first), []);
  assert.deepEqual(await options.store.inspect(second), []);
  assert.deepEqual(await options.catalog.list(options.workspace), []);
});

test("恢复的空会话在退出后继续保留", async t => {
  const options = await storageOptions(t);
  const original = await MaybeCodeApplication.open(options);
  const sessionId = original.sessionId;
  await original.close();
  await options.catalog.record({ id: sessionId, workspace: options.workspace, createdAt: 1, lastUsedAt: 1 });
  const app = await MaybeCodeWorkspace.open({ ...options, sessionId });
  await app.close();
  assert.ok((await options.store.inspect(sessionId)).length > 0);
  assert.ok((await options.catalog.list(options.workspace)).some(session => session.id === sessionId));
});

test("提交消息后即使模型请求失败，退出后仍然保留会话", async t => {
  const options = await storageOptions(t);
  const app = await MaybeCodeWorkspace.open(options);
  const sessionId = app.sessionId;
  try {
    const run = await app.submit({ input: "Preserve this message" });
    await assert.rejects(run.result, /URL/u);
  } finally {
    await app.close();
  }
  const history = await options.store.inspect(sessionId);
  assert.ok(history.some(event => event.type === "input.submitted"));
  assert.ok((await options.catalog.list(options.workspace)).some(session => session.id === sessionId));
});

test("启动并暂停 goal 后，退出时保留会话", async t => {
  const { goals: _goals, ...options } = await storageOptions(t);
  const app = await MaybeCodeWorkspace.open(options);
  const sessionId = app.sessionId;
  try {
    await app.startGoal("Preserve this goal");
    await app.pauseGoal();
  } finally {
    await app.close();
  }
  const history = await options.store.inspect(sessionId);
  assert.equal(history.some(event => event.type === "run.started"), false);
  assert.ok(history.some(event => event.type === "state.updated" && event.key === "may.goal"));
  assert.ok((await options.catalog.list(options.workspace)).some(session => session.id === sessionId));
});

test("提交补充消息后取消执行，退出后仍然保留会话", async t => {
  const options = await storageOptions(t);
  const app = await MaybeCodeWorkspace.open(options);
  const sessionId = app.sessionId;
  try {
    await app.steer({ input: "Preserve this steering message" });
    await app.cancel("Cancelled by the user");
  } finally {
    await app.close();
  }
  const history = await options.store.inspect(sessionId);
  assert.ok(history.some(event => event.type === "input.steering.queued"));
  assert.ok((await options.catalog.list(options.workspace)).some(session => session.id === sessionId));
});
