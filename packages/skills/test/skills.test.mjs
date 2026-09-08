import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, link, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry, SkillSession, parseSkill } from "../dist/index.js";

const source = (body = "Read references/guide.md and follow the procedure.") => `---\nname: research\ndescription: >-\n  Research a topic\n  using primary sources.\nmetadata:\n  version: "1"\nallowed-tools: shell\n---\n${body}`;
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "may-skills-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "research");
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(join(directory, "SKILL.md"), source());
  await writeFile(join(directory, "references", "guide.md"), "Primary sources only.");
  return { root, directory };
}

test("parses standard YAML frontmatter and rejects malformed or unsafe metadata", () => {
  assert.equal(parseSkill(source(), "research").description, "Research a topic using primary sources.");
  assert.equal(parseSkill(source()).metadata.version, "1");
  for (const invalid of ["plain markdown", source().replace("name: research", "name: Research"), source().replace("name: research", "name: research\nname: other"), source().replace('version: "1"', "version: 1"), source().replace("name: research", "name: &name research\nlicense: *name")]) {
    assert.throws(() => parseSkill(invalid));
  }
  assert.throws(() => parseSkill(source(), "mismatch"));
});

test("discovery exposes metadata only, later roots win, and invalid skills are diagnosed", async (t) => {
  const { root } = await fixture(t);
  const later = join(root, "later"); await mkdir(join(later, "research"), { recursive: true });
  await writeFile(join(later, "research", "SKILL.md"), source("Later procedure"));
  await mkdir(join(later, "invalid")); await writeFile(join(later, "invalid", "SKILL.md"), "invalid");
  const registry = await SkillRegistry.discover([join(root, "missing"), root, later]);
  assert.equal(registry.list().length, 1);
  assert.equal("body" in registry.list()[0], false);
  assert.doesNotMatch(registry.catalogInstructions(), /Later procedure/);
  assert.equal((await registry.load("research")).body, "Later procedure");
  assert.ok(registry.diagnostics.some((d) => d.message.includes("Overrides")));
  assert.ok(registry.diagnostics.some((d) => d.path.endsWith("invalid")));
});

test("bounded resource reads reject traversal, binary data, links and changed skill revisions", async (t) => {
  const { root, directory } = await fixture(t);
  const registry = await SkillRegistry.discover([root]);
  assert.equal(await registry.readResource("research", "references/guide.md"), "Primary sources only.");
  for (const path of ["../secret", "/secret", "references/../../secret", "C:/secret", "references\\guide.md", "a:stream"]) await assert.rejects(registry.readResource("research", path));
  await writeFile(join(directory, "binary"), Buffer.from([0xff]));
  await assert.rejects(registry.readResource("research", "binary"));
  await link(join(directory, "references", "guide.md"), join(directory, "linked"));
  await assert.rejects(registry.readResource("research", "linked"), /single-link/);
  const external = join(root, "external"); await mkdir(external); await writeFile(join(external, "secret"), "secret");
  await symlink(external, join(directory, "outside"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(registry.readResource("research", "outside/secret"), /Linked/);
  await writeFile(join(directory, "SKILL.md"), source("changed"));
  await assert.rejects(registry.load("research"), /changed since discovery/);
});

test("activation is deduplicated, persisted before publication, and restored as a snapshot", async (t) => {
  const { root, directory } = await fixture(t);
  const registry = await SkillRegistry.discover([root]);
  const session = new SkillSession(registry); let stored; let writes = 0;
  session.setSink(async (next) => { assert.equal(session.listActive().length, 0); stored = structuredClone(next); writes++; });
  await Promise.all([session.activate("research"), session.activate("research")]);
  assert.equal(writes, 1);
  await writeFile(join(directory, "SKILL.md"), source("new procedure"));
  const restored = new SkillSession(await SkillRegistry.discover([root]));
  restored.restore(stored);
  assert.match(restored.instructions(), /Read references/);
  assert.doesNotMatch(restored.instructions(), /new procedure/);
  const tool = restored.readTool();
  await assert.rejects(tool.execute({ name: "research", path: "references/guide.md" }, { signal: new AbortController().signal }), /changed since activation/);
});

test("failed persistence never publishes an activation and cancelled loading is rejected", async (t) => {
  const { root } = await fixture(t);
  const session = new SkillSession(await SkillRegistry.discover([root]));
  session.setSink(async () => { throw new Error("disk failed"); });
  await assert.rejects(session.activate("research"), /could not be persisted/);
  assert.equal(session.listActive().length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(session.activate("research", controller.signal));
});
