import assert from "node:assert/strict";
import test from "node:test";
import { liveModelProfile } from "../fixtures/live-model.mjs";
import { workspaceFor } from "../fixtures/plugin-workspace.mjs";
import { join } from "node:path";
import { loadMayConfig } from "@sortedyuan/may/config";
import { createBuiltinProviderModel, selectProviderModel } from "@sortedyuan/providers";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { goalsService } from "@sortedyuan/may/goals/plugin";
import { delegationService, defaultSubagentConfiguration } from "@sortedyuan/coordination/delegation";
import { historyMemoryService } from "@sortedyuan/may/history-memory";
import { MaybeCodeApplication } from "../../dist/application.js";

async function realModel() {
  const config = await loadMayConfig();
  return createBuiltinProviderModel(selectProviderModel(config, { model: liveModelProfile() }));
}

test(
  "product plugin goals use actual model and tools and restore their persisted controller state",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-goals-live-");
    const model = await realModel();
    const store = new FileSessionStore(join(workspace, "sessions"));
    const options = {
      workspace,
      model,
      store,
      skills: false,
      subagents: false,
      instructions: "Use the tools requested by the user and provide evidence from their actual outputs.",
      maxSteps: 8,
    };
    const application = await MaybeCodeApplication.open(options);
    t.after(() => application.close());
    assert.equal(application.goals, application.agent.getService(goalsService));
    assert.ok(application.agent.getService(historyMemoryService).memory);
    await application.startGoal(
      "Use the read tool to read README.md. When the first Markdown heading is confirmed from the tool output, call update_goal with status completed and quote that heading as evidence. Do not use shell.",
      { maxRuns: 3, maxTotalTokens: 100000 },
    );
    await application.goals.wait();
    const goal = application.getGoal();
    assert.equal(goal.status, "completed");
    assert.ok(goal.usage.totalTokens > 0);
    const history = await application.history();
    assert.ok(history.some((event) => event.type === "tool.completed" && event.call.name === "read"));
    assert.ok(
      history.some(
        (event) =>
          event.type === "state.updated" &&
          event.key === "may.plugins" &&
          event.value.application["may.goals"].value.goal?.status === "completed",
      ),
    );
    const sessionId = application.sessionId;
    await application.close();
    const resumed = await MaybeCodeApplication.open({ ...options, sessionId, resume: true });
    t.after(() => resumed.close());
    assert.equal(resumed.getGoal().id, goal.id);
    assert.equal(resumed.getGoal().status, "completed");
    const result = await (
      await resumed.submit({ input: "Reply with exactly GOAL_RESTORED. Do not call any tools." })
    ).result;
    assert.match(JSON.stringify(result.message), /GOAL_RESTORED/u);
  },
);

test(
  "history-memory plugin saves actual tool evidence, compacts Context and restores notes",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-memory-live-");
    const store = new FileSessionStore(join(workspace, "sessions"));
    const options = {
      workspace,
      model: await realModel(),
      store,
      skills: false,
      goals: false,
      subagents: false,
      autoCompactionMode: "history-reference",
      maxSteps: 8,
    };
    const application = await MaybeCodeApplication.open(options);
    t.after(() => application.close());
    await (
      await application.submit({
        input:
          "Use read to read README.md. After read finishes, call context_notes with action save in a separate single-tool step. Set goal to Verify the first heading, constraints to Read only, progress to the actual first Markdown heading, and nextSteps to Report the verified heading. Then reply MEMORY_SAVED. Do not call new_context or other tools.",
      })
    ).result;
    const before = await application.history();
    assert.ok(before.some((event) => event.type === "tool.completed" && event.call.name === "read"));
    const completedReads = before.filter(
      (event) => event.type === "tool.completed" && event.call.name === "read",
    ).length;
    const pluginState = before.filter((event) => event.type === "state.updated" && event.key === "may.plugins").at(-1);
    const notes = pluginState.value.application["may.history-memory"].value.notes;
    assert.match(notes.notes.progress, /May/u);
    const compacted = await application.compactContext("history-reference");
    assert.equal(compacted.changed, true);
    assert.ok(compacted.messages.some((message) => JSON.stringify(message).includes(notes.notes.progress)));
    const sessionId = application.sessionId;
    await application.close();
    const resumed = await MaybeCodeApplication.open({ ...options, sessionId, resume: true });
    t.after(() => resumed.close());
    const restored = await resumed.history();
    assert.equal(
      restored.filter((event) => event.type === "tool.completed" && event.call.name === "read").length,
      completedReads,
    );
    const result = await (
      await resumed.submit({
        input:
          "Use context_notes with action read, then quote the saved progress field exactly. Do not read files or change notes.",
      })
    ).result;
    assert.match(JSON.stringify(result.message), /May/u);
    const history = await resumed.history();
    const readNotes = history
      .filter(
        (event) =>
          event.type === "tool.completed" && event.call.name === "context_notes" && event.runId === result.runId,
      )
      .at(-1);
    assert.deepEqual(readNotes.output.notes, notes.notes);
  },
);

test(
  "closing active goal and delegation plugins cancels actual provider streaming and preserves final state",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-closing-live-");
    const store = new FileSessionStore(join(workspace, "sessions"));
    const options = {
      workspace,
      model: await realModel(),
      store,
      skills: false,
      maxSteps: 8,
      subagents: { dataDirectory: workspace },
      instructions: "Follow the user's requested text response. Do not use tools unless needed.",
    };
    const application = await MaybeCodeApplication.open(options);
    t.after(() => application.close());
    let ready;
    const modelStreaming = new Promise((resolve) => {
      ready = resolve;
    });
    const observing = (async () => {
      for await (const event of application.events) {
        if (event.type === "run.event" && ["model.text.delta", "model.reasoning.delta"].includes(event.event.type))
          ready();
      }
    })();
    await application.startGoal(
      "Write a detailed tutorial with at least 100 paragraphs about filesystem permissions. Do not call any tools or update_goal yet.",
      { maxRuns: 2 },
    );
    await modelStreaming;
    await Promise.all([application.close(), application.close()]);
    await observing;
    await application.goals.wait();
    assert.equal(application.getGoal().status, "paused");
    const history = await store.read(application.sessionId);
    const pluginState = history.filter((event) => event.type === "state.updated" && event.key === "may.plugins").at(-1)
      .value.application;
    assert.equal(pluginState["may.goals"].value.goal.status, "paused");
    assert.equal(pluginState["may.delegation"].value.requests[0].status, "cancelled");
    const resumed = await MaybeCodeApplication.open({ ...options, sessionId: application.sessionId, resume: true });
    t.after(() => resumed.close());
    assert.equal(resumed.getGoal().status, "paused");
    assert.equal(resumed.listDelegationRequests()[0].status, "cancelled");
  },
);

test(
  "delegation plugin executes an actual child agent with separate Session and shared budget",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-delegation-live-");
    const base = defaultSubagentConfiguration();
    const application = await MaybeCodeApplication.open({
      workspace,
      model: await realModel(),
      store: new FileSessionStore(join(workspace, "sessions")),
      skills: false,
      goals: false,
      maxSteps: 8,
      instructions:
        "Use delegate_tasks when the user explicitly requests delegation. Read only. Return the child's evidence after it completes.",
      subagents: {
        dataDirectory: workspace,
        configuration: {
          ...base,
          roles: [{ name: "worker", tools: ["read"], delegateTo: [] }],
          limits: { ...base.limits, maxTasks: 2 },
        },
      },
    });
    t.after(() => application.close());
    assert.equal(application.subagents, application.agent.getService(delegationService).get());
    const result = await (
      await application.submit({
        input:
          "Delegate exactly one worker task with id read-doc. Give it a standalone brief: use read to read README.md, then return the first Markdown heading quoted from the actual read output. Assign no files for modification. When it finishes, reply with that heading. Do not read the file yourself and do not use shell.",
      })
    ).result;
    assert.match(JSON.stringify(result.message), /May/u);
    const state = application.getDelegationState();
    const child = state.tasks.find((task) => task.id === "read-doc");
    assert.ok(child);
    assert.equal(child.status, "completed");
    assert.notEqual(child.sessionId, application.sessionId);
    assert.ok(state.budget.modelCalls >= 3);
    const records = await application.delegationToolRecords(child.id);
    assert.ok(records.records.some((record) => record.name === "read" && record.status === "completed"));
    const sessionId = application.sessionId;
    const requests = application.listDelegationRequests();
    await application.close();
    const resumed = await MaybeCodeApplication.open({
      workspace,
      model: await realModel(),
      store: new FileSessionStore(join(workspace, "sessions")),
      sessionId,
      resume: true,
      skills: false,
      goals: false,
      subagents: {
        dataDirectory: workspace,
        configuration: {
          ...base,
          roles: [{ name: "worker", tools: ["read"], delegateTo: [] }],
          limits: { ...base.limits, maxTasks: 2 },
        },
      },
    });
    t.after(() => resumed.close());
    assert.equal(resumed.listDelegationRequests()[0].requestId, requests[0].requestId);
    assert.equal(resumed.listDelegationRequests()[0].status, "completed");
  },
);
