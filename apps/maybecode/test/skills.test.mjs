import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore, InMemorySessionCatalog } from "@may/session";
import { MaybeCodeWorkspace, executeMaybeCodeSlashCommand, createMaybeCodeSlashCommandSuggester } from "../dist/index.js";

async function fixture(t) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "may-skills-app-")));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const directory = join(workspace, ".agents", "skills", "research");
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), "---\nname: research\ndescription: Research topics using sources\nallowed-tools: shell\n---\nPINNED_PROCEDURE: use primary sources.\nRead references/guide.md.");
  await writeFile(join(directory, "references", "guide.md"), "RESOURCE_CONTENT");
  return { workspace, directory };
}

test("skills commands list, preview, activate, complete and explicitly submit without granting execution", async (t) => {
  const { workspace } = await fixture(t); let requests = 0; let last;
  const app = await MaybeCodeWorkspace.open({ workspace, store: new InMemorySessionStore(), catalog: new InMemorySessionCatalog(), model: {
    async *stream(request) { requests++; last = request; yield { type: "response.completed", message: { role: "assistant", content: [] } }; },
  }});
  t.after(() => app.close());
  assert.match((await executeMaybeCodeSlashCommand("/skills", app)).text, /research/);
  assert.doesNotMatch(app.instructions.effective, /PINNED_PROCEDURE/);
  assert.match((await executeMaybeCodeSlashCommand("/skills show research", app)).text, /PINNED_PROCEDURE/);
  assert.equal(app.listSkills()[0].active, false);
  assert.equal(requests, 0);
  const suggest = createMaybeCodeSlashCommandSuggester(app);
  const suggestions = await suggest("/skills use re");
  assert.ok(suggestions.some((item) => item.value === "/skills use research"));
  await executeMaybeCodeSlashCommand("/skills use research", app);
  assert.equal(app.listSkills()[0].active, true);
  assert.equal(requests, 0);
  assert.match(app.instructions.effective, /PINNED_PROCEDURE/);
  const result = await executeMaybeCodeSlashCommand("/skills use research inspect the topic", app);
  assert.equal(result.type, "skill.run-started"); await result.run.result;
  assert.equal(requests, 1);
  assert.match(last.messages[0].content[0].text, /PINNED_PROCEDURE/);
  assert.equal((await app.history()).filter((e) => e.type === "state.updated").length, 1);
  assert.equal((await executeMaybeCodeSlashCommand("/skills show research extra", app)).type, "usage");
});

test("model activation loads resources, remains after compaction/resume and resets for a new session", async (t) => {
  const { workspace, directory } = await fixture(t);
  const store = new InMemorySessionStore(); const catalog = new InMemorySessionCatalog(); let requests = 0; let last;
  const model = { async *stream(request) {
    last = request; requests++;
    yield { type: "response.completed", message: { role: "assistant", content: [], ...(requests <= 2 ? { toolCalls: [{ id: `call${requests}`, name: "skill_read", input: requests === 1 ? { name: "research" } : { name: "research", path: "references/guide.md" } }] } : {}) } };
  }};
  const options = { workspace, store, catalog, model, autoCompactionStrategies: [] };
  const app = await MaybeCodeWorkspace.open(options);
  await (await app.submit({ input: "use research" })).result;
  assert.equal(app.listSkills()[0].active, true);
  assert.match(JSON.stringify(last.messages), /RESOURCE_CONTENT/);
  assert.equal((await app.history()).some((e) => e.type === "approval.requested"), false);
  await app.compactContext({ name: "remove-all", compact() { return []; } });
  const sessionId = app.sessionId; await app.close();
  await writeFile(join(directory, "SKILL.md"), "---\nname: research\ndescription: Updated description\n---\nNEW_PROCEDURE");
  const resumed = await MaybeCodeWorkspace.open({ ...options, sessionId });
  t.after(() => resumed.close());
  await (await resumed.submit({ input: "continue" })).result;
  assert.match(last.messages[0].content[0].text, /PINNED_PROCEDURE/);
  assert.doesNotMatch(last.messages[0].content[0].text, /NEW_PROCEDURE/);
  assert.equal(resumed.listSkills()[0].active, true);
  await resumed.newSession();
  assert.equal(resumed.listSkills()[0].active, false);
  await resumed.activateSkill("research");
  assert.match(resumed.instructions.effective, /NEW_PROCEDURE/);
});
