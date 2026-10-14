import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { OpenAIResponsesModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { MaybeCodeApplication, MaybeCodeWorkspace } from "../dist/index.js";
import { createTestWorkspace } from "./fixtures/workspace.mjs";

test("真实 CLI 通过 /quit 退出后清理历史文件和会话目录", async t => {
  const workspace = await createTestWorkspace(t);
  const home = join(workspace, "home");
  await mkdir(home);
  const configPath = join(workspace, "may.json");
  await writeFile(configPath, JSON.stringify({
    providers: { local: { adapter: "openai-responses", apiKey: "unused-without-model-requests" } },
    defaultModel: "offline",
    models: { offline: { provider: "local", model: "gpt-4.1" } },
    apps: { maybecode: { git: false } },
  }));
  const execution = promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
    "--config", configPath, "--ui", "classic", workspace,
  ], {
    cwd: workspace,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    windowsHide: true,
    timeout: 15_000,
  });
  execution.child.stdin.end("/quit\n");
  const { stderr } = await execution;
  assert.equal(stderr, "");
  const dataDirectory = join(home, ".may", "maybecode");
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
