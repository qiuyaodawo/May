import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, sep } from "node:path";
import { loadMayConfig } from "@may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@may/providers";
import { FileSessionStore } from "@may/session/file-store";
import { goalsService } from "@may/plugin-goals";
import { delegationService, defaultSubagentConfiguration } from "@may/plugin-delegation";
import { historyMemoryService } from "@may/plugin-history-memory";
import { createMcpPlugin } from "@may/plugin-mcp";
import { openMcpClientPool } from "@may/mcp";
import { MaybeCodeApplication, openConfiguredMaybeCode } from "../../dist/index.js";

async function workspaceFor(t, label) {
  const base = fileURLToPath(new URL("../../../../plugin-verification/", import.meta.url));
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, label));
  t.after(async () => { assert.ok(resolve(workspace).startsWith(resolve(base) + sep)); await rm(workspace, { recursive: true, force: true }); });
  await writeFile(join(workspace, "README.md"), await readFile(new URL("../../../../README.md", import.meta.url)));
  return workspace;
}

async function realModel() {
  const config = await loadMayConfig();
  return createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" }));
}

test("product plugin goals use actual model and tools and restore their persisted controller state", { timeout: 120000 }, async (t) => {
  const workspace = await workspaceFor(t, "plugin-goals-live-");
  const model = await realModel();
  const store = new FileSessionStore(join(workspace, "sessions"));
  const options = { workspace, model, store, skills: false, subagents: false, instructions: "Use the tools requested by the user and provide evidence from their actual outputs.", maxSteps: 8 };
  const application = await MaybeCodeApplication.open(options);
  t.after(() => application.close());
  assert.equal(application.goals, application.getService(goalsService));
  assert.ok(application.getService(historyMemoryService).memory);
  await application.startGoal("Use the read tool to read README.md. When the first Markdown heading is confirmed from the tool output, call update_goal with status completed and quote that heading as evidence. Do not use shell.", { maxRuns: 3, maxTotalTokens: 100000 });
  await application.goals.wait();
  const goal = application.getGoal();
  assert.equal(goal.status, "completed");
  assert.ok(goal.usage.totalTokens > 0);
  const history = await application.history();
  assert.ok(history.some(event => event.type === "tool.completed" && event.call.name === "read"));
  assert.ok(history.some(event => event.type === "state.updated" && event.key === "may.plugins" && event.value.application["may.goals"].value.goal?.status === "completed"));
  const sessionId = application.sessionId;
  await application.close();
  const resumed = await MaybeCodeApplication.open({ ...options, sessionId, resume: true });
  t.after(() => resumed.close());
  assert.equal(resumed.getGoal().id, goal.id);
  assert.equal(resumed.getGoal().status, "completed");
  const result = await (await resumed.submit({ input: "Reply with exactly GOAL_RESTORED. Do not call any tools." })).result;
  assert.match(JSON.stringify(result.message), /GOAL_RESTORED/u);
});

test("history-memory plugin saves actual tool evidence, compacts Context and restores notes", { timeout: 120000 }, async (t) => {
  const workspace = await workspaceFor(t, "plugin-memory-live-");
  const store = new FileSessionStore(join(workspace, "sessions"));
  const options = { workspace, model: await realModel(), store, skills: false, goals: false, subagents: false, autoCompactionMode: "history-reference", maxSteps: 8 };
  const application = await MaybeCodeApplication.open(options);
  t.after(() => application.close());
  await (await application.submit({ input: "Use read to read README.md. After read finishes, call context_notes with action save in a separate single-tool step. Set goal to Verify the first heading, constraints to Read only, progress to the actual first Markdown heading, and nextSteps to Report the verified heading. Then reply MEMORY_SAVED. Do not call new_context or other tools." })).result;
  const before = await application.history();
  assert.ok(before.some(event => event.type === "tool.completed" && event.call.name === "read"));
  const completedReads = before.filter(event => event.type === "tool.completed" && event.call.name === "read").length;
  const pluginState = before.filter(event => event.type === "state.updated" && event.key === "may.plugins").at(-1);
  const notes = pluginState.value.application["may.history-memory"].value.notes;
  assert.match(notes.notes.progress, /May/u);
  const compacted = await application.compactContext("history-reference");
  assert.equal(compacted.changed, true);
  assert.ok(compacted.messages.some(message => JSON.stringify(message).includes(notes.notes.progress)));
  const sessionId = application.sessionId;
  await application.close();
  const resumed = await MaybeCodeApplication.open({ ...options, sessionId, resume: true });
  t.after(() => resumed.close());
  const restored = await resumed.history();
  assert.equal(restored.filter(event => event.type === "tool.completed" && event.call.name === "read").length, completedReads);
  const result = await (await resumed.submit({ input: "Use context_notes with action read, then quote the saved progress field exactly. Do not read files or change notes." })).result;
  assert.match(JSON.stringify(result.message), /May/u);
  const history = await resumed.history();
  const readNotes = history.filter(event => event.type === "tool.completed" && event.call.name === "context_notes" && event.runId === result.runId).at(-1);
  assert.deepEqual(readNotes.output.notes, notes.notes);
});

test("closing active goal and delegation plugins cancels actual provider streaming and preserves final state", { timeout: 120000 }, async (t) => {
  const workspace = await workspaceFor(t, "plugin-closing-live-");
  const store = new FileSessionStore(join(workspace, "sessions"));
  const options = { workspace, model: await realModel(), store, skills: false, maxSteps: 8, subagents: { dataDirectory: workspace }, instructions: "Follow the user's requested text response. Do not use tools unless needed." };
  const application = await MaybeCodeApplication.open(options);
  t.after(() => application.close());
  let ready;
  const modelStreaming = new Promise(resolve => { ready = resolve; });
  const observing = (async () => {
    for await (const event of application.events) {
      if (event.type === "run.event" && ["model.text.delta", "model.reasoning.delta"].includes(event.event.type)) ready();
    }
  })();
  await application.startGoal("Write a detailed tutorial with at least 100 paragraphs about filesystem permissions. Do not call any tools or update_goal yet.", { maxRuns: 2 });
  await modelStreaming;
  await Promise.all([application.close(), application.close()]);
  await observing;
  await application.goals.wait();
  assert.equal(application.getGoal().status, "paused");
  const history = await store.read(application.sessionId);
  const pluginState = history.filter(event => event.type === "state.updated" && event.key === "may.plugins").at(-1).value.application;
  assert.equal(pluginState["may.goals"].value.goal.status, "paused");
  assert.equal(pluginState["may.delegation"].value.requests[0].status, "cancelled");
  const resumed = await MaybeCodeApplication.open({ ...options, sessionId: application.sessionId, resume: true });
  t.after(() => resumed.close());
  assert.equal(resumed.getGoal().status, "paused");
  assert.equal(resumed.listDelegationRequests()[0].status, "cancelled");
});

test("delegation plugin executes an actual child agent with separate Session and shared budget", { timeout: 120000 }, async (t) => {
  const workspace = await workspaceFor(t, "plugin-delegation-live-");
  const base = defaultSubagentConfiguration();
  const application = await MaybeCodeApplication.open({
    workspace, model: await realModel(), store: new FileSessionStore(join(workspace, "sessions")),
    skills: false, goals: false, maxSteps: 8,
    instructions: "Use delegate_tasks when the user explicitly requests delegation. Read only. Return the child's evidence after it completes.",
    subagents: { dataDirectory: workspace, configuration: {
      ...base, roles: [{ name: "worker", tools: ["read"], delegateTo: [] }], limits: { ...base.limits, maxTasks: 2 },
    } },
  });
  t.after(() => application.close());
  assert.equal(application.subagents, application.getService(delegationService).get());
  const result = await (await application.submit({ input: "Delegate exactly one worker task with id read-doc. Give it a standalone brief: use read to read README.md, then return the first Markdown heading quoted from the actual read output. Assign no files for modification. When it finishes, reply with that heading. Do not read the file yourself and do not use shell." })).result;
  assert.match(JSON.stringify(result.message), /May/u);
  const state = application.getDelegationState();
  const child = state.tasks.find(task => task.id === "read-doc");
  assert.ok(child);
  assert.equal(child.status, "completed");
  assert.notEqual(child.sessionId, application.sessionId);
  assert.ok(state.budget.modelCalls >= 3);
  const records = await application.delegationToolRecords(child.id);
  assert.ok(records.records.some(record => record.name === "read" && record.status === "completed"));
  const sessionId = application.sessionId;
  const requests = application.listDelegationRequests();
  await application.close();
  const resumed = await MaybeCodeApplication.open({
    workspace, model: await realModel(), store: new FileSessionStore(join(workspace, "sessions")),
    sessionId, resume: true, skills: false, goals: false,
    subagents: { dataDirectory: workspace, configuration: { ...base, roles: [{ name: "worker", tools: ["read"], delegateTo: [] }], limits: { ...base.limits, maxTasks: 2 } } },
  });
  t.after(() => resumed.close());
  assert.equal(resumed.listDelegationRequests()[0].requestId, requests[0].requestId);
  assert.equal(resumed.listDelegationRequests()[0].status, "completed");
});

test("configured MCP and tracing plugins serve actual files across Session changes and flush on close", { timeout: 120000 }, async (t) => {
  const workspace = await workspaceFor(t, "plugin-mcp-live-");
  const application = await openConfiguredMaybeCode({
    git: false,
    workspace, model: "deepseek-v4-flash", dataDirectory: join(workspace, "data"), skills: false, subagents: false, goals: false,
    instructions: "Use the exact tool name requested and quote evidence from the tool output.",
    observability: { scheduledDelayMs: 60000 },
    mcp: { servers: [{ id: "filesystem", command: process.execPath, args: [fileURLToPath(new URL("../../../../packages/plugins/mcp/test/read-server.mjs", import.meta.url)), workspace], protocolMode: "auto" }] },
  });
  t.after(() => application.close());
  const events = [];
  const observing = (async () => { for await (const event of application.events) {
    events.push(event);
    if (event.type === "permission.event" && event.event.type === "approval.requested") await application.resolveApproval(event.event.request.id, "allow");
  } })();
  const result = await (await application.submit({ input: "Use mcp__filesystem__read to read README.md, then quote only its first Markdown heading. Do not use the local read tool or shell." })).result;
  assert.match(JSON.stringify(result.message), /May/u);
  const firstSession = application.sessionId;
  await application.newSession();
  assert.notEqual(application.sessionId, firstSession);
  assert.equal((await application.getMcpStatus())[0].state, "connected");
  await application.close();
  await observing;
  assert.ok(events.some(event => event.type === "run.event" && event.event.type === "tool.completed" && event.event.call.name === "mcp__filesystem__read"));
  const traces = join(workspace, "data", "traces");
  const files = await readdir(traces);
  const spans = (await Promise.all(files.map(file => readFile(join(traces, file), "utf8")))).join("\n").trim().split(/\n+/u).map(value => JSON.parse(value));
  assert.ok(spans.some(span => span.name === "may.model.call"));
  assert.ok(spans.some(span => span.name.startsWith("may.mcp")));
});

test("selected MCP services expose actual catalog, commands and events and own each Session connection", { timeout: 120000 }, async t => {
  const workspace = await workspaceFor(t, "plugin-selected-mcp-live-");
  const pools = [];
  const plugin = createMcpPlugin({
    servers: [{ id: "filesystem", command: process.execPath, args: [fileURLToPath(new URL("../../../../packages/plugins/mcp/test/read-server.mjs", import.meta.url)), workspace], protocolMode: "auto" }],
    enableInteractions: true,
    async open(options) {
      const pool = await openMcpClientPool(options);
      pools.push(pool);
      return pool;
    },
  });
  const application = await openConfiguredMaybeCode({
    git: false,
    workspace, model: "deepseek-v4-flash", dataDirectory: join(workspace, "data"),
    plugins: [plugin], skills: false, goals: false, subagents: false,
    mcp: { servers: [{ id: "unused", command: "unused-mcp-command" }] },
    instructions: "Use the exact requested tool and quote its actual output. Do not use other tools.",
  });
  t.after(() => application.close());
  const events = [];
  const observing = (async () => {
    for await (const event of application.events) {
      events.push(event);
      if (event.type === "permission.event" && event.event.type === "approval.requested") await application.resolveApproval(event.event.request.id, "allow");
    }
  })();
  assert.equal(pools.length, 1);
  assert.deepEqual((await application.getMcpStatus()).map(server => server.serverId), ["filesystem"]);
  assert.equal((await application.getMcpStatus())[0].state, "connected");
  assert.deepEqual(application.getMcpCatalog(), pools[0].catalog());
  assert.ok(application.getMcpCatalog()[0].tools.some(tool => tool.name === "read"));
  const revision = application.getMcpCatalog()[0].revision;
  await application.refreshMcp("filesystem");
  assert.equal(application.getMcpCatalog()[0].revision, revision);
  await application.reconnectMcp("filesystem");
  const result = await (await application.submit({ input: "Use mcp__filesystem__read to read README.md, then quote only its first Markdown heading." })).result;
  assert.match(JSON.stringify(result.message), /May/u);
  const previous = application.sessionId;
  await application.newSession();
  assert.notEqual(application.sessionId, previous);
  assert.equal(pools.length, 2);
  assert.equal(pools[0].status()[0].state, "disconnected");
  assert.equal((await application.getMcpStatus())[0].state, "connected");
  assert.deepEqual(application.getMcpCatalog(), pools[1].catalog());
  await application.refreshMcp("filesystem");
  await application.resumeSession(previous);
  assert.equal(application.sessionId, previous);
  assert.equal(pools.length, 3);
  assert.equal(pools[1].status()[0].state, "disconnected");
  assert.deepEqual(application.getMcpCatalog(), pools[2].catalog());
  await application.refreshMcp("filesystem");
  await Promise.all([application.close(), application.close()]);
  await observing;
  assert.ok(pools.every(pool => pool.status()[0].state === "disconnected"));
  assert.ok(events.filter(event => event.type === "mcp.server.connected" && event.serverId === "filesystem").length >= 3);
  assert.ok(events.some(event => event.type === "run.event" && event.event.type === "tool.completed" && event.event.call.name === "mcp__filesystem__read"));
});

test("delegation children use the selected MCP service with their own Session and actual filesystem permission", { timeout: 120000 }, async t => {
  const workspace = await workspaceFor(t, "plugin-child-mcp-live-");
  const base = defaultSubagentConfiguration();
  const application = await openConfiguredMaybeCode({
    git: false,
    workspace, model: "deepseek-v4-flash", dataDirectory: join(workspace, "data"),
    plugins: [createMcpPlugin({
      servers: [{ id: "filesystem", command: process.execPath, args: [fileURLToPath(new URL("../../../../packages/plugins/mcp/test/read-server.mjs", import.meta.url)), workspace], protocolMode: "auto" }],
    })],
    skills: false, goals: false, maxSteps: 8,
    subagents: { configuration: { ...base, roles: [{ name: "worker", tools: ["read"], delegateTo: [] }], limits: { ...base.limits, maxTasks: 2 } } },
    instructions: "Use delegate_tasks when delegation is requested. Child tasks must use the exact MCP tool requested and quote evidence from the actual tool output.",
  });
  t.after(() => application.close());
  const approvals = [];
  const observing = (async () => {
    for await (const event of application.events) {
      const permission = event.type === "delegation.event" ? event.event : event;
      if (permission.type === "permission.event" && permission.event.type === "approval.requested") {
        approvals.push(event);
        await application.resolveApproval(permission.event.request.id, "allow");
      }
    }
  })();
  const result = await (await application.submit({ input: "Delegate exactly one worker task with id mcp-read-doc. Provide this standalone brief: use mcp__filesystem__read to read README.md and quote its first Markdown heading from the actual output. Do not use local read or shell, and do not modify any files. After the child completes, reply with its heading. Do not read the file yourself." })).result;
  assert.match(JSON.stringify(result.message), /May/u);
  const state = application.getDelegationState();
  const child = state.tasks.find(task => task.id === "mcp-read-doc");
  assert.ok(child);
  assert.equal(child.status, "completed");
  assert.notEqual(child.sessionId, application.sessionId);
  const records = await application.delegationToolRecords(child.id);
  assert.ok(records.records.some(record => record.name === "mcp__filesystem__read" && record.status === "completed"));
  assert.ok(approvals.some(event => event.type === "delegation.event" && event.sessionId === child.sessionId));
  assert.ok(state.budget.modelCalls >= 3);
  assert.equal((await application.history()).filter(event => event.type === "tool.completed" && event.call.name === "mcp__filesystem__read").length, 0);
  await application.close();
  await observing;
});
