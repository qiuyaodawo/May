import assert from "node:assert/strict";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applicationHooks, applicationServices } from "@sortedyuan/may";
import { historyMemoryService } from "@sortedyuan/may/history-memory";
import { goalsService } from "@sortedyuan/may/goals/plugin";
import { delegationService } from "@sortedyuan/coordination/delegation";
import { createMcpPlugin, mcpService } from "@sortedyuan/mcp/plugin";
import { MaybeCodeApplication, openConfiguredMaybeCode } from "../dist/index.js";
import { InMemorySessionStore } from "@sortedyuan/may/session";
import { localModel, yoloDirectory } from "./yolo-support.mjs";

async function fixture(t, extra = {}) {
  const workspace = await yoloDirectory();
  const configPath = join(workspace, "may.json");
  const resourcePath = join(workspace, "resource.txt");
  await writeFile(resourcePath, "resource available");
  const skillDirectory = join(workspace, "skills", "model-update-check");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: model-update-check\ndescription: Verify model update state\n---\nPreserve MODEL_UPDATE_SKILL_ACTIVE during model updates.\n");
  const profiles = {
    first: { provider: "local", model: "o3", contextWindowTokens: 32000 },
    second: { provider: "local", model: "o3-mini", contextWindowTokens: 64000,
      capabilities: { reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" } } },
  };
  await writeFile(configPath, JSON.stringify({ providers: { local: {
    adapter: "openai-responses", apiKey: "unused-without-model-requests", baseURL: "http://127.0.0.1:1/v1",
  } }, models: profiles, defaultModel: "first", apps: { maybecode: { permissionMode: "yolo" } } }));
  const instances = [], handles = [], events = [];
  const observer = {
    id: "verification.model-lifecycle", version: "1.0.0",
    requires: [{ service: applicationServices.application }, { service: historyMemoryService },
      { service: goalsService }, { service: delegationService }],
    optional: [{ service: mcpService }],
    state: { version: 1, initial: { creations: 0 } },
    async setup(context) {
      const handle = await open(resourcePath, "r");
      handles.push(handle);
      context.defer(() => handle.close());
      context.on(applicationHooks.created, async () => {
        await context.state.update(value => ({ creations: value.creations + 1 }));
        instances.push({ application: context.get(applicationServices.application).get(),
          history: context.get(historyMemoryService), goals: context.get(goalsService),
          subagents: context.get(delegationService).get(), mcp: context.optional(mcpService),
          creations: context.state.get().creations });
      }, { order: 100 });
    },
  };
  const app = await openConfiguredMaybeCode({ workspace, configPath, dataDirectory: join(workspace, "data"),
    git: false, skillDirectories: [join(workspace, "skills")], mcp: false, observability: false,
    ...extra, plugins: [observer, ...(extra.plugins ?? [])] });
  const relay = (async () => { for await (const event of app.events) events.push(event); })();
  t.after(async () => { await app.close(); await relay; });
  return { app, instances, handles, events, workspace, resourcePath };
}

test("模型和 reasoning effort 更新保留 application 并更新服务、状态和资源", { timeout: 30000 }, async t => {
  const { app, instances, handles, events } = await fixture(t);
  const first = instances[0], sessionId = app.sessionId;
  await app.activateSkill("model-update-check");
  await app.startGoal("Verify paused goal persistence");
  await app.pauseGoal();
  const paused = app.getGoal();
  assert.equal(paused.status, "paused");
  assert.equal(paused.usage.runs, 0);
  assert.equal((await app.inspectContext()).contextWindowTokens, 32000);
  for (const transition of [() => app.switchModel("second"), () => app.setReasoningEffort("low"), () => app.setReasoningEffort()]) {
    const previous = instances.at(-1);
    await transition();
    const current = instances.at(-1);
    assert.equal(current.application, first.application);
    assert.equal(app.sessionId, sessionId);
    assert.equal(app.modelInfo.profile, "second");
    assert.equal(app.permissionMode, "yolo");
    assert.equal(app.listSkills().find(skill => skill.name === "model-update-check").active, true);
    assert.equal((await app.inspectContext()).contextWindowTokens, 64000);
    assert.deepEqual(app.getGoal(), paused);
    assert.notEqual(current.history, previous.history);
    assert.notEqual(current.goals, previous.goals);
    assert.notEqual(current.subagents, previous.subagents);
    assert.equal(current.creations, instances.length);
    assert.ok(handles.slice(0, -1).every(handle => handle.fd === -1));
    assert.ok(handles.at(-1).fd >= 0);
    await assert.rejects(previous.goals.resume(), /closed/i);
    const names = current.application.getService(applicationServices.toolSources).snapshot().names();
    assert.equal(new Set(names).size, names.length);
    await assert.rejects(previous.subagents.start({ input: "Verify closed host", record: "Verify closed host" }), /closed/i);
    assert.ok(names.includes("get_context_remaining"));
    assert.equal((await app.history()).filter(event => event.type === "session.created").length, 1);
  }
  assert.equal((await app.getReasoningEffort()).overridden, false);
  const saved = (await app.history()).filter(event => event.type === "state.updated" && event.key === "maybecode.model");
  assert.deepEqual(saved.map(event => event.value.runtimeOptions), [{}, {}, { reasoningEffort: "low" }, {}]);
  await app.cancelGoal();
  await app.close();
  assert.equal(events.filter(event => event.type === "model.changed").length, 3);
  assert.equal(events.filter(event => event.type === "goal.changed" && event.goal.status === "cancelled").length, 1);
  assert.ok(handles.every(handle => handle.fd === -1));
});

test("application 管理的 MCP 服务在模型更新后重新连接并释放旧资源", { timeout: 30000 }, async t => {
  const server = fileURLToPath(new URL("../../../packages/mcp/test/fixtures/workspace-resource-server.mjs", import.meta.url));
  const { app, instances } = await fixture(t, { plugins: [createMcpPlugin({
    servers: [{ id: "workspace", transport: "stdio", command: process.execPath, args: [server], required: true, protocolMode: "auto" }],
  })] });
  const original = instances[0].mcp;
  assert.ok(original);
  await app.switchModel("second");
  const updated = instances.at(-1).mcp;
  assert.notEqual(updated, original);
  assert.equal((await app.getMcpStatus())[0].state, "connected");
  assert.throws(() => original.readResource("workspace", "workspace:///value"), /closed/i);
  await app.setReasoningEffort("low");
  assert.notEqual(instances.at(-1).mcp, updated);
  assert.equal((await app.getMcpStatus())[0].state, "connected");
  assert.throws(() => updated.readResource("workspace", "workspace:///value"), /closed/i);
});

test("插件资源读取失败会终止模型更新，恢复资源后可以重试", { timeout: 30000 }, async t => {
  const { app, instances, handles, resourcePath } = await fixture(t);
  await rm(resourcePath);
  await assert.rejects(app.switchModel("second"), /initialization failed/i);
  assert.equal(app.modelInfo.profile, "first");
  assert.ok(handles.every(handle => handle.fd === -1));
  await assert.rejects(app.submit({ input: "Do not send this request" }), /Model update failed/);
  await writeFile(resourcePath, "resource restored");
  await app.switchModel("first");
  assert.equal(app.modelInfo.profile, "first");
  assert.equal((await app.inspectContext()).contextWindowTokens, 32000);
  await app.switchModel("second");
  assert.equal(app.modelInfo.profile, "second");
  assert.equal(instances.at(-1).application, instances[0].application);
  assert.equal(app.permissionMode, "yolo");
  assert.equal((await app.inspectContext()).contextWindowTokens, 64000);
});

test("共享 MCP 连接和订阅在模型更新后继续使用", { timeout: 30000 }, async t => {
  const server = fileURLToPath(new URL("../../../packages/mcp/test/fixtures/workspace-resource-server.mjs", import.meta.url));
  const { app, instances, workspace } = await fixture(t, {
    mcp: { servers: [{ id: "workspace", command: process.execPath, args: [server], required: true, protocolMode: "auto" }] },
  });
  await writeFile(join(workspace, "value.txt"), "MODEL_UPDATE_RESOURCE");
  const subscription = await app.watchMcpResource("workspace", "workspace:///value");
  const pool = instances[0].mcp;
  assert.ok(pool);
  await app.switchModel("second");
  await app.setReasoningEffort("low");
  assert.equal(instances.at(-1).mcp, pool);
  assert.equal(await app.watchMcpResource("workspace", "workspace:///value"), subscription);
  assert.equal((await app.readMcpResource("workspace", "workspace:///value")).result.contents[0].text, "MODEL_UPDATE_RESOURCE");
  await app.unwatchMcpResource("workspace", "workspace:///value");
  assert.equal(await subscription.closed, "local");
});

test("关闭等待模型更新完成，并发输入和重复更新立即失败", { timeout: 30000 }, async t => {
  const workspace = await yoloDirectory();
  const path = join(workspace, "owned-resource.txt");
  await writeFile(path, "model update lifecycle");
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const handles = [];
  const app = await MaybeCodeApplication.open({ workspace, model: localModel(), store: new InMemorySessionStore(),
    skills: false, goals: false, subagents: false, plugins: [{
      id: "verification.update-boundary", version: "1.0.0",
      async setup(context) {
        const handle = await open(path, "r");
        handles.push(handle);
        context.defer(() => handle.close());
        context.on(applicationHooks.created, async () => {
          if (handles.length === 2) { entered.resolve(); await release.promise; }
        });
      },
    }] });
  t.after(async () => { release.resolve(); await app.close(); });
  const update = { model: localModel(), modelInfo: { provider: "openai", model: "gpt-4.1", profile: "second", adapter: "openai-responses" } };
  const updating = app.updateModel(update);
  await entered.promise;
  assert.equal(app.isRunning, true);
  await assert.rejects(app.submit({ input: "Must not start during the update" }), /Finish the model update/);
  await assert.rejects(app.updateModel(update), /Finish the active operation/);
  let closed = false;
  const closing = app.close().then(() => { closed = true; });
  assert.equal(closed, false);
  assert.equal(handles[0].fd, -1);
  assert.ok(handles[1].fd >= 0);
  release.resolve();
  await updating;
  await closing;
  assert.equal(closed, true);
  assert.ok(handles.every(handle => handle.fd === -1));
  await assert.rejects(app.updateModel(update), /closed/);
});
