import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MaybeCodeApplication } from "../../dist/index.js";
import { applicationServices } from "../../../../packages/application/dist/index.js";
import { loadMayConfig } from "../../../../packages/config/dist/index.js";
import { RunCancelledError, runtimeHooks } from "../../../../packages/core/dist/index.js";
import { definePlugin } from "../../../../packages/plugin/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../../packages/providers/dist/index.js";
import { InMemorySessionStore } from "../../../../packages/session/dist/index.js";
import { SkillRegistry } from "../../../../packages/skills/dist/index.js";

async function workspaceFor(t) {
  const parent = fileURLToPath(new URL("../../../../review/prompt-verification/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const workspace = await mkdtemp(join(parent, "workspace-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

async function configuredModel() {
  return createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" }));
}

test("startup ancestor rules reach the actual request and refresh after input", { timeout: 30_000 }, async t => {
  const repository = await workspaceFor(t);
  const workspace = join(repository, "packages", "web");
  await mkdir(join(repository, ".git"));
  await mkdir(workspace, { recursive: true });
  await writeFile(join(repository, "AGENTS.md"), "Repository startup guidance.");
  await writeFile(join(repository, "packages", "AGENTS.md"), "Package startup guidance.");
  await writeFile(join(workspace, "AGENTS.md"), "Web startup guidance.");
  let application;
  const requests = [];
  application = await MaybeCodeApplication.open({
    workspace, model: await configuredModel(), store: new InMemorySessionStore(),
    goals: false, subagents: false, skills: false,
    plugins: [definePlugin({
      id: "verification.startup-rules", version: "1.0.0",
      requiresHooks: [runtimeHooks.modelBefore],
      setup(context) {
        context.on(runtimeHooks.modelBefore, request => {
          requests.push(request);
          application.cancel("Startup rule verification before provider dispatch");
          return request;
        });
      },
    })],
  });
  t.after(() => application.close());
  assert.equal(application.workspace, workspace);
  assert.equal(application.instructions.projects.length, 3);
  await assert.rejects((await application.submit({ input: "Read the project guidance." })).result, RunCancelledError);
  const first = requests[0].messages[0].content[0].text;
  assert.ok(first.includes(`Workspace: ${workspace}`));
  assert.ok(first.indexOf("Repository startup guidance.") < first.indexOf("Package startup guidance."));
  assert.ok(first.indexOf("Package startup guidance.") < first.indexOf("Web startup guidance."));
  for (const directory of [repository, join(repository, "packages"), workspace]) {
    assert.ok(first.includes(`Source: ${await realpath(join(directory, "AGENTS.md"))}`));
  }
  assert.equal(application.instructions.effective, first);

  await writeFile(join(repository, "AGENTS.override.md"), "Updated repository guidance.");
  await rm(join(repository, "packages", "AGENTS.md"));
  await assert.rejects((await application.submit({ input: "Continue reading the guidance." })).result, RunCancelledError);
  const second = requests[1].messages[0].content[0].text;
  assert.match(second, /Updated repository guidance/u);
  assert.doesNotMatch(second, /Repository startup guidance|Package startup guidance/u);
  assert.match(second, /Web startup guidance/u);
  assert.equal(application.instructions.projects.length, 2);
  assert.equal(application.instructions.effective, second);
});

test("MaybeCode assembles actual tool metadata and refreshes project and permission instructions", { timeout: 30_000 }, async t => {
  const workspace = await workspaceFor(t);
  const skillsDirectory = join(workspace, "skills");
  await mkdir(join(skillsDirectory, "source-review"), { recursive: true });
  await writeFile(join(skillsDirectory, "source-review", "SKILL.md"), "---\nname: source-review\ndescription: Inspect source files\n---\nRead README.md before reporting its heading.");
  await writeFile(join(workspace, "AGENTS.md"), "Use the original project guidance.");
  let permissionMode = "default";
  let application;
  const requests = [];
  application = await MaybeCodeApplication.open({
    workspace, model: await configuredModel(), store: new InMemorySessionStore(),
    goals: false, subagents: false, autoCompactionMode: "history-reference",
    skills: await SkillRegistry.discover([skillsDirectory]),
    permissionModeSource: () => permissionMode,
    plugins: [definePlugin({
      id: "verification.prompt-context", version: "1.0.0",
      requiresHooks: [runtimeHooks.modelBefore],
      setup(context) {
        context.on(runtimeHooks.modelBefore, request => {
          requests.push(request);
          application.cancel("Instruction verification before provider dispatch");
          return request;
        });
      },
    })],
  });
  t.after(() => application.close());
  await writeFile(join(workspace, "AGENTS.md"), "Read the current project guidance.");
  await assert.rejects((await application.submit({ input: "Read README.md" })).result, RunCancelledError);
  const first = requests[0].messages[0].content[0].text;
  const headings = ["You are MaybeCode", "# Current environment", "# Project instructions", "# Tool use", "# Available skills", "# Context continuity"];
  for (let index = 1; index < headings.length; index++) {
    assert.ok(first.indexOf(headings[index - 1]) < first.indexOf(headings[index]), headings[index]);
  }
  assert.equal(first.match(/^Shell:/gmu).length, 1);
  assert.match(first, /Read the current project guidance/u);
  assert.doesNotMatch(first, /Use the original project guidance/u);
  assert.doesNotMatch(first, /Read README\.md before reporting/u);
  assert.match(first, /Permission mode: default/u);
  assert.equal(application.instructions.effective, first);
  assert.ok(requests[0].tools.some(tool => tool.name === "shell"));

  await application.getService(applicationServices.skills).activate("source-review");
  permissionMode = "yolo";
  await writeFile(join(workspace, "AGENTS.md"), "Use the updated project guidance.");
  await assert.rejects((await application.submit({ input: "Continue the source review" })).result, RunCancelledError);
  const second = requests[1].messages[0].content[0].text;
  assert.match(second, /Permission mode: yolo/u);
  assert.match(second, /Use the updated project guidance/u);
  assert.doesNotMatch(second, /Read the current project guidance/u);
  assert.match(second, /# Active skills/u);
  assert.match(second, /Read README\.md before reporting/u);
});

test("MaybeCode delegates a real read under the composed main and child instructions", { timeout: 120_000 }, async t => {
  const workspace = await workspaceFor(t);
  await writeFile(join(workspace, "README.md"), "# Prompt verification\nA source document for the delegation check.\n");
  await writeFile(join(workspace, "AGENTS.md"), "Use read to verify README.md. Return the heading exactly as written.");
  let application;
  const instructions = [];
  application = await MaybeCodeApplication.open({
    workspace, model: await configuredModel(), store: new InMemorySessionStore(),
    goals: false, skills: false, permissionPolicy: () => "allow",
    subagents: { dataDirectory: join(workspace, "delegation") },
    plugins: [definePlugin({
      id: "verification.prompt-observation", version: "1.0.0",
      requiresHooks: [runtimeHooks.modelBefore],
      setup(context) {
        context.on(runtimeHooks.modelBefore, request => {
          instructions.push(request.messages[0].content[0].text);
          return request;
        });
      },
    })],
  });
  t.after(() => application.close());
  assert.doesNotMatch(application.instructions.effective, /# Delegation context/u);
  const run = await application.submit({ input: "Use delegate_tasks to assign one worker task with id read-heading and files []. Give it a complete standalone brief: read README.md using read, report its first heading exactly, and modify no files. After its report arrives, return the heading. Delegate this task now." });
  const result = await run.result;
  assert.match(result.message.content.filter(part => part.type === "text").map(part => part.text).join(""), /Prompt verification/u);
  const request = application.listDelegationRequests()[0];
  const child = request.tasks.find(task => task.parentTaskId !== undefined);
  assert.ok(child, "An actual child task must be recorded");
  assert.equal(child.status, "completed");
  assert.match(child.output, /Prompt verification/u);
  const records = await application.delegationToolRecords(child.id);
  assert.ok(records.records.some(record => record.name === "read" && record.status === "completed"));
  assert.match(instructions[0], /# Delegation context/u);
  assert.equal(instructions[0].match(/^Shell:/gmu).length, 1);
  assert.doesNotMatch(application.instructions.effective, /# Delegation context/u);
  assert.match(await readFile(join(workspace, "README.md"), "utf8"), /^# Prompt verification/u);
  assert.equal((await application.inspectContext()).measurementMethod, "estimated");
});

test("steering refreshes project guidance and changed instructions invalidate actual provider measurements", { timeout: 120_000 }, async t => {
  const workspace = await workspaceFor(t);
  const store = new InMemorySessionStore();
  const model = await configuredModel();
  await writeFile(join(workspace, "README.md"), "# Steering verification\n");
  await writeFile(join(workspace, "AGENTS.md"), "Read README.md before reporting its heading.");
  let application;
  let steered = false;
  let permissionMode = "default";
  const instructions = [];
  application = await MaybeCodeApplication.open({
    workspace, model, store,
    goals: false, skills: false, subagents: false,
    permissionModeSource: () => permissionMode,
    plugins: [definePlugin({
      id: "verification.steering-guidance", version: "1.0.0",
      requiresHooks: [runtimeHooks.modelBefore, runtimeHooks.toolAfter],
      setup(context) {
        context.on(runtimeHooks.modelBefore, request => {
          instructions.push(request.messages[0].content[0].text);
          return request;
        });
        context.on(runtimeHooks.toolAfter, async outcome => {
          if (steered || outcome.call.name !== "read") return;
          steered = true;
          await writeFile(join(workspace, "AGENTS.md"), "Report the verified heading exactly, with no additional text.");
          await application.steer({ input: "Return the first README.md heading exactly as written." });
        });
      },
    })],
  });
  t.after(() => application.close());
  const run = await application.submit({ input: "Use read to read README.md and report its first heading." });
  const result = await run.result;
  assert.ok(steered);
  assert.match(result.message.content.filter(part => part.type === "text").map(part => part.text).join(""), /Steering verification/u);
  assert.match(instructions[0], /Read README\.md before reporting/u);
  assert.match(instructions.at(-1), /Report the verified heading exactly/u);
  assert.doesNotMatch(instructions.at(-1), /Read README\.md before reporting/u);
  assert.equal((await application.inspectContext()).measurementMethod, "measured+estimated");
  permissionMode = "yolo";
  assert.equal((await application.inspectContext()).measurementMethod, "estimated");
  const sessionId = application.sessionId;
  const positions = await application.getService(applicationServices.application).get().branchPositions();
  assert.ok(positions.length > 0);
  await application.close();
  application = await MaybeCodeApplication.open({
    workspace, model, store, sessionId, resume: true,
    goals: false, skills: false, subagents: false,
    permissionModeSource: () => permissionMode,
  });
  assert.match(application.instructions.effective, /Session origin: resumed session/u);
  assert.equal((await application.inspectContext()).measurementMethod, "estimated");
  await application.close();
  const branch = await MaybeCodeApplication.open({
    workspace, model, store,
    fork: { sessionId, positionSeq: positions.at(-1).positionSeq },
    goals: false, skills: false, subagents: false,
  });
  t.after(() => branch.close());
  assert.match(branch.instructions.effective, /Session origin: historical branch/u);
  assert.ok(branch.instructions.effective.includes(`Source session: ${sessionId}`));
});
