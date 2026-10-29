import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { applicationHooks, applicationServices } from "@sortedyuan/may/application";
import { runtimeHooks } from "@sortedyuan/may/core";
import { historyMemoryService } from "@sortedyuan/may/history-memory";
import { goalsService } from "@sortedyuan/may/goals/plugin";
import { openConfiguredMaybeCode } from "../../dist/index.js";

test("真实模型更新后 shell、权限、notes、压缩和委派目标继续运行", { timeout: 240000 }, async t => {
  const base = fileURLToPath(new URL("../../../../review/model-update-live/", import.meta.url));
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, "case-"));
  await writeFile(join(workspace, "evidence.txt"), "MODEL_UPDATE_CHILD_EVIDENCE\n");
  const applications = [], requests = [], events = [];
  let app;
  app = await openConfiguredMaybeCode({
    workspace, dataDirectory: join(workspace, "data"), git: false, skills: false, mcp: false,
    observability: false, model: "gemini-3.8-flash-low", permissionMode: "yolo",
    instructions: "Follow the user's exact tool requests. Use shell for explicitly requested shell commands. Use delegate_tasks for explicitly requested delegation. Do not modify files. Keep replies brief.",
    plugins: [{ id: "verification.live-model-update", version: "1.0.0",
      requires: [{ service: applicationServices.application }, { service: applicationServices.modelInfo }],
      setup(context) {
        context.on(applicationHooks.created, () => { applications.push(context.get(applicationServices.application).get()); }, { order: 100 });
        context.on(runtimeHooks.modelBefore, request => {
          requests.push(context.get(applicationServices.modelInfo));
          return request;
        });
      } }],
  });
  const relay = (async () => {
    for await (const event of app.events) {
      events.push(event);
      if (event.type === "permission.event" && event.event.type === "approval.requested") {
        await app.resolveApproval(event.event.request.id, "allow");
      }
    }
  })();
  t.after(async () => { await app.close(); await relay; });
  const run = async input => {
    const value = await app.submit({ input });
    return value.result;
  };
  await run("Call context_notes once with action save and notes: goal='Verify model updates', constraints='Read only', progress='LIVE_NOTES_BEFORE_SWITCH', nextSteps='Switch model'. Make no other tool calls in that step. Then reply NOTES_READY.");
  const notesBefore = [...await app.history()].reverse().find(event => event.type === "state.updated" && event.key === "maybecode.context-notes");
  assert.ok(notesBefore);
  await app.switchModel("deepseek-v4-flash");
  await app.setReasoningEffort("low");
  assert.equal(applications.length, 3);
  assert.ok(applications.every(value => value === applications[0]));
  const notesTool = applications[0].getService(historyMemoryService).memory.tools().find(tool => tool.name === "context_notes");
  assert.deepEqual((await notesTool.execute(notesTool.parse({ action: "read" }), { signal: new AbortController().signal })).notes, notesBefore.value.notes);
  const command = process.platform === "win32" ? "Write-Output 'MODEL_UPDATE_SHELL'" : "printf 'MODEL_UPDATE_SHELL'";
  await run(`Call shell with this exact command: ${command}. Return its output.`);
  assert.equal(events.filter(event => event.type === "permission.event" && event.event.type === "approval.requested").length, 0);
  assert.ok((await app.history()).some(event => event.type === "tool.completed" && event.call.name === "shell" && event.output.stdout.includes("MODEL_UPDATE_SHELL")));
  await app.setPermissionMode("default");
  await run(`Call shell with this exact command: ${command}. Return its output.`);
  assert.equal(events.filter(event => event.type === "permission.event" && event.event.type === "approval.requested").length, 1);
  await app.setPermissionMode("yolo");
  await app.setReasoningEffort();
  assert.equal((await app.getReasoningEffort()).overridden, false);
  await app.compactContext("summary-tail");
  await app.startGoal("Use delegate_tasks exactly once to assign worker a read-only task, id read-evidence and files []. Tell the worker to use read on evidence.txt and return its exact contents. Wait for its result, then call update_goal with status completed and the evidence marker in progress. Do not read the file yourself.", { maxRuns: 2 });
  await applications[0].getService(goalsService).wait();
  assert.equal(app.getGoal().status, "completed");
  assert.ok(app.listDelegationRequests().some(request => request.tasks.some(task => task.parentTaskId !== undefined && task.status === "completed" && task.output.includes("MODEL_UPDATE_CHILD_EVIDENCE"))));
  assert.equal(events.filter(event => event.type === "permission.event" && event.event.type === "approval.requested").length, 1);
  assert.ok(requests.some(info => info.profile === "gemini-3.8-flash-low"));
  assert.ok(requests.some(info => info.profile === "deepseek-v4-flash"));
  assert.equal(app.permissionMode, "yolo");
});
