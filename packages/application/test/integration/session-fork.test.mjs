import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { AgentApplication, AgentWorkspace, applicationHooks, applicationServices } from "../../dist/index.js";
import { FileSessionCatalog, InMemorySessionCatalog } from "../../../session/dist/catalog.js";
import { readSessionBranchPositions } from "../../../session/dist/index.js";
import { FileSessionStore } from "../../../session/dist/file-store.js";
import { loadMayConfig } from "../../../config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../providers/dist/index.js";
import { SkillRegistry } from "../../../skills/dist/index.js";

test("durable Session forks restore the selected real-provider Context and declared state", { timeout: 90_000 }, async (t) => {
  const root = resolve("../../review/session-fork-verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skillsDirectory = join(directory, "skills", "fork-guidance");
  await mkdir(skillsDirectory, { recursive: true });
  await writeFile(join(skillsDirectory, "SKILL.md"), "---\nname: fork-guidance\ndescription: Preserve request identifiers.\n---\nAlways retain user-provided identifiers.\n");
  const skills = await SkillRegistry.discover([join(directory, "skills")]);
  const config = await loadMayConfig();
  const model = createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" }));
  const store = new FileSessionStore(join(directory, "sessions"));
  const outputFile = join(directory, "tool-output.txt");
  const recordingTool = { name: "record_fork_marker", description: "Append FIRST_FORK_MARKER to the request verification file once.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async execute() { await appendFile(outputFile, "FIRST_FORK_MARKER\n"); return { recorded: true }; } };
  const application = await AgentApplication.open({ model, store, skills, tools: [recordingTool], permissionPolicy: () => "allow" });
  t.after(() => application.close());
  await application.activateSkill("fork-guidance");
  await application.recordState("test.branch", { version: 1 });
  await application.recordState("test.unshared", { value: "private" });
  await application.steer({ input: "Leave this queued until explicitly submitted.", inputId: "unconsumed-input" });
  const first = await application.submit({ input: "Call record_fork_marker exactly once. Remember the identifier FIRST_FORK_MARKER. Then reply with exactly FIRST_FORK_MARKER.", inputId: "first-input" });
  await first.result;
  assert.equal(await readFile(outputFile, "utf8"), "FIRST_FORK_MARKER\n");
  const position = (await application.branchPositions()).find((value) => value.runId === first.id);
  assert.equal(position.available, true);
  await application.recordState("test.branch", { version: 2 });
  const second = await application.submit({ input: "Remember the identifier LATER_FORK_MARKER. Reply with exactly LATER_FORK_MARKER." });
  await second.result;
  const originalHistory = await application.history();
  await application.close();
  const reopenedStore = new FileSessionStore(join(directory, "sessions"));
  const validationFailureId = "fork-validation-failure";
  await assert.rejects(AgentApplication.open({ model, store: reopenedStore, sessionId: validationFailureId,
    fork: { sessionId: application.sessionId, positionSeq: position.positionSeq },
    validateSession: () => readFile(join(directory, "missing-required-workspace.json")) }));
  const validationFailure = await reopenedStore.inspect(validationFailureId);
  assert.equal(validationFailure[0].fork.sessionId, application.sessionId);
  assert.equal(validationFailure.some(event => event.type === "session.fork.ready"), false);
  assert.ok(readSessionBranchPositions(validationFailure).every(item => !item.available));
  await assert.rejects(AgentApplication.open({ model, store: reopenedStore, sessionId: validationFailureId, resume: true }), /incomplete fork/u);
  const hookFailureId = "fork-created-hook-failure";
  const requiredFilePlugin = { id: "verification.required-fork-resource", version: "1.0.0",
    setup(context) { context.on(applicationHooks.created, () => readFile(join(directory, "missing-required-resource.txt"))); } };
  await assert.rejects(AgentApplication.open({ model, store: reopenedStore, sessionId: hookFailureId,
    fork: { sessionId: application.sessionId, positionSeq: position.positionSeq }, plugins: [requiredFilePlugin] }));
  const hookFailure = await reopenedStore.inspect(hookFailureId);
  assert.equal(hookFailure[0].fork.sessionId, application.sessionId);
  assert.equal(hookFailure.some(event => event.type === "session.fork.ready"), false);
  assert.ok(readSessionBranchPositions(hookFailure).every(item => !item.available));
  await assert.rejects(AgentApplication.open({ model, store: reopenedStore, sessionId: hookFailureId, resume: true }), /incomplete fork/u);
  const createdStatePlugin = { id: "verification.persisted-fork-initialization", version: "1.0.0",
    requires: [{ service: applicationServices.application }],
    setup(context) { context.on(applicationHooks.created, async () => {
      const current = context.get(applicationServices.application).get();
      assert.ok((await current.branchPositions()).every(item => !item.available));
      await current.recordState("test.created", { bytes: (await readFile(join(skillsDirectory, "SKILL.md"))).length });
    }); } };
  const forked = await AgentApplication.open({ model, store: reopenedStore, skills, permissionPolicy: () => "deny",
    fork: { sessionId: application.sessionId, positionSeq: position.positionSeq }, forkStateKeys: ["test.branch"], plugins: [createdStatePlugin] });
  t.after(() => forked.close());
  assert.notEqual(forked.sessionId, application.sessionId);
  const history = await forked.history();
  assert.ok(history.find(event => event.type === "session.fork.ready").seq > history.find(event => event.type === "state.updated" && event.key === "test.created").seq);
  assert.equal(await readFile(outputFile, "utf8"), "FIRST_FORK_MARKER\n");
  assert.deepEqual(history[0].fork, { sessionId: application.sessionId, positionSeq: position.positionSeq, runId: first.id });
  assert.equal(history.find((event) => event.type === "assistant.completed").seq,
    originalHistory.find((event) => event.type === "assistant.completed").seq);
  assert.equal(history.some((event) => event.type === "input.submitted" && event.message.content.some((part) => part.text?.includes("LATER_FORK_MARKER"))), false);
  assert.equal(history.some((event) => event.type === "state.updated" && event.key === "test.branch" && event.value.version === 2), false);
  assert.equal(history.some((event) => event.type === "state.updated" && event.key === "test.unshared"), false);
  assert.deepEqual(history.filter((event) => event.type === "assistant.completed").map((event) => event.message),
    originalHistory.filter((event) => event.type === "assistant.completed" && event.seq <= position.positionSeq).map((event) => event.message));
  assert.equal(history.filter((event) => event.type === "tool.completed" && event.call.name === "record_fork_marker").length, 1);
  assert.equal(history.some((event) => event.type.startsWith("approval.")), false);
  assert.equal(history.some((event) => event.type.startsWith("input.steering.")), false);
  assert.equal(history.some((event) => event.type === "input.submitted" && event.inputId !== undefined), false);
  assert.deepEqual(forked.listSteeringInputs(), []);
  assert.deepEqual(forked.skills.listActive().map((value) => value.name), ["fork-guidance"]);
  assert.deepEqual(await reopenedStore.inspect(application.sessionId), originalHistory);
  const invalid = originalHistory.find((event) => event.type === "assistant.completed");
  await assert.rejects(AgentApplication.open({ model, store: reopenedStore, permissionPolicy: () => "deny",
    fork: { sessionId: application.sessionId, positionSeq: invalid.seq } }), /recoverable state/);
  const continuation = await forked.submit({ input: "What identifier did I tell you to remember? Reply with only that identifier.", inputId: "first-input" });
  assert.match((await continuation.result).message.content.map((part) => part.text ?? "").join(""), /FIRST_FORK_MARKER/u);
  await forked.close();
  const restored = await AgentApplication.open({ model, store: reopenedStore, skills, permissionPolicy: () => "deny", sessionId: forked.sessionId, resume: true });
  t.after(() => restored.close());
  assert.deepEqual((await restored.history())[0].fork, history[0].fork);
  assert.equal((await restored.branchPositions()).some((value) => value.runId === continuation.id && value.available), true);
});

test("AgentWorkspace creates and catalogs independent selected-position branches", { timeout: 60_000 }, async (t) => {
  const root = resolve("../../review/session-fork-verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadMayConfig();
  const model = createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" }));
  const store = new FileSessionStore(join(directory, "sessions"));
  const catalog = new InMemorySessionCatalog();
  const destination = join(directory, "independent-workspace");
  const workspace = await AgentWorkspace.open({ workspace: directory, store, catalog, workspacePaths: () => [directory, destination],
    openApplication: (selection) => AgentApplication.open({ model, store, permissionPolicy: () => "deny", ...selection }) });
  t.after(() => workspace.close());
  const run = await workspace.submit({ input: "Reply with exactly BRANCH_TREE_READY." });
  await run.result;
  const originalId = workspace.sessionId;
  const position = (await workspace.branchPositions())[0];
  const forkedId = await workspace.forkSession(originalId, position.positionSeq);
  assert.notEqual(forkedId, originalId);
  const tree = await workspace.readSessionBranchTree();
  assert.equal(tree.length, 2);
  assert.deepEqual(tree.find((node) => node.sessionId === forkedId).fork,
    { sessionId: originalId, positionSeq: position.positionSeq, runId: run.id });
  const nextPosition = (await workspace.branchPositions())[0];
  const nextId = await workspace.forkSession(forkedId, nextPosition.positionSeq, { workspace: destination, metadata: { workspace: destination } });
  assert.equal(workspace.workspace, destination);
  assert.equal((await catalog.list(destination))[0].id, nextId);
  assert.equal((await workspace.readSessionBranchTree()).length, 3);
  await workspace.resumeSession(originalId);
  assert.equal(workspace.workspace, directory);
  await workspace.renameSession(nextId, "Independent workspace branch");
  assert.equal((await catalog.list(destination))[0].title, "Independent workspace branch");
  assert.equal(await workspace.deleteSession(nextId), true);
  assert.equal((await catalog.list(destination)).length, 0);
});

test("fork catalog persistence failure keeps the source Application active and preserves candidate history", { timeout: 60_000 }, async t => {
  const root = resolve("../../review/session-fork-verification");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "catalog-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadMayConfig();
  const model = createBuiltinProviderModel(selectProviderModel(config, { model: "deepseek-v4-flash" }));
  const store = new FileSessionStore(join(directory, "sessions"));
  const catalog = new FileSessionCatalog(join(directory, "catalog.json"));
  const operations = `${catalog.path}.operations`;
  let candidateId;
  const workspace = await AgentWorkspace.open({ workspace: directory, store, catalog,
    openApplication: async selection => {
      const application = await AgentApplication.open({ model, store, permissionPolicy: () => "deny", ...selection });
      if (selection.fork) {
        candidateId = application.sessionId;
        await rename(operations, `${operations}-saved`);
        await writeFile(operations, "catalog storage is unavailable");
      }
      return application;
    } });
  t.after(() => workspace.close());
  const sourceId = workspace.sessionId;
  const run = await workspace.submit({ input: "Reply with exactly SOURCE_REMAINS_AVAILABLE." });
  await run.result;
  const position = (await workspace.branchPositions())[0];
  await assert.rejects(workspace.forkSession(sourceId, position.positionSeq), /could not be recorded in the catalog/u);
  assert.equal(workspace.sessionId, sourceId);
  assert.equal(workspace.workspace, directory);
  assert.equal((await store.inspect(candidateId))[0].fork.sessionId, sourceId);
  await rm(operations);
  await rename(`${operations}-saved`, operations);
  assert.deepEqual((await catalog.list(directory)).map(item => item.id), [sourceId]);
  const continuation = await workspace.submit({ input: "Reply with exactly SOURCE_CONTINUED." });
  assert.match((await continuation.result).message.content.map(part => part.text ?? "").join(""), /SOURCE_CONTINUED/u);
});
