import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore, InMemorySessionCatalog } from "@may/session";
import { MaybeCodeWorkspace, executeMaybeCodeSlashCommand, createMaybeCodeSlashCommandSuggester,
  resolveMaybeCodeSkillDirectories, runTerminalUI, runRetainedTerminalUI } from "../dist/index.js";

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
  const before = await app.inspectContext();
  assert.ok(before.instructionsBytes > 200);
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

test("skill config resolves relative and home roots and supports disabling", () => {
  const config = { path: join(process.cwd(), "settings", "config.json"), apps: { maybecode: { skills: { directories: ["custom", "~/skills"] } } } };
  assert.equal(resolveMaybeCodeSkillDirectories(config, process.cwd())[0], join(process.cwd(), "settings", "custom"));
  assert.equal(resolveMaybeCodeSkillDirectories({ ...config, apps: { maybecode: { skills: false } } }, process.cwd()), false);
  assert.throws(() => resolveMaybeCodeSkillDirectories({ ...config, apps: { maybecode: { skills: { directories: [1] } } } }, process.cwd()));
});

test("classic terminal displays skills and activates without a model request", { timeout: 5000 }, async (t) => {
  const { workspace } = await fixture(t);
  for (const ui of [runTerminalUI]) {
    const app = await MaybeCodeWorkspace.open({ workspace, store: new InMemorySessionStore(), catalog: new InMemorySessionCatalog(), model: {
      async *stream() { throw new Error("preview must not call the model"); },
    }});
    const answers = ["/skills", "/skills show research", "/skills use research", "/quit"];
    const terminal = { interactive: false, colors: false, output: "", write(text) { this.output += text; },
      async question() { return answers.shift() ?? "/quit"; }, setInterruptHandler() {}, close() {},
    };
    try { await ui(app, { terminal }); assert.match(terminal.output, /research/); assert.equal(app.listSkills()[0].active, true); }
    finally { await app.close(); }
  }
});

test("retained terminal displays and activates skills", { timeout: 5000 }, async (t) => {
  const { workspace } = await fixture(t);
  const app = await MaybeCodeWorkspace.open({ workspace, store: new InMemorySessionStore(), catalog: new InMemorySessionCatalog(), model: { async *stream() { throw new Error("Unexpected model call"); } } });
  let onKey; let output = "";
  const terminal = { size: { width: 120, height: 40 }, write() {}, start() {}, close() {},
    onKey(listener) { onKey = listener; return () => {}; }, onResize() { return () => {}; },
  };
  const renderer = { render(frame) { output += frame.lines.join("\n") + "\n"; }, invalidate() {}, dispose() {} };
  const running = runRetainedTerminalUI(app, { terminal, renderer });
  const until = async (predicate) => { for (let n = 0; n < 1000 && !predicate(); n++) await new Promise((r) => setTimeout(r, 1)); assert.ok(predicate()); };
  const send = (input) => {
    for (const text of input) onKey({ key: text, text, ctrl: false, alt: false, shift: false, meta: false });
    onKey({ key: "enter", ctrl: false, alt: false, shift: false, meta: false });
  };
  try {
    await until(() => onKey !== undefined);
    send("/skills"); await until(() => output.includes("Research topics"));
    send("/skills use research"); await until(() => output.includes("Activated research"));
    await new Promise((resolve) => setImmediate(resolve));
    send("/quit"); await running;
  } finally { await app.close(); }
});
