import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TaskWorkspaceManager } from "@may/coordination";
import { applyTeamPatch, createTeamPatch, readTeamPatchApplication, renderTeamPatchDiff } from "../dist/team-patches.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "may-team-patches-"));
  const source = join(root, "source");
  const directory = join(root, "team");
  await mkdir(source);
  await writeFile(join(source, "a.txt"), "before-a\n");
  await writeFile(join(source, "b.txt"), "before-b\n");
  const workspaces = await TaskWorkspaceManager.open({ sourceDirectory: source, directory: join(directory, "workspaces") });
  t.after(async () => { await workspaces.close(); await rm(root, { recursive: true, force: true }); });
  return { source, directory, workspaces };
}

test("review bundles deduplicate identical edits, expose conflicts, and reject drift before all source writes", async (t) => {
  const setup = await fixture(t);
  const a = await setup.workspaces.prepare("a");
  const b = await setup.workspaces.prepare("b");
  await writeFile(join(a.directory, "a.txt"), "after-a\n");
  await writeFile(join(b.directory, "a.txt"), "different-a\n");
  let bundle = await createTeamPatch({ ...setup, taskIds: ["a", "b"] });
  assert.equal(bundle.conflicts.length, 1);
  assert.match(renderTeamPatchDiff(bundle), /CONFLICT a.txt/u);
  await assert.rejects(applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest }), /conflicting/u);
  await writeFile(join(b.directory, "a.txt"), "after-a\n");
  await unlink(join(a.directory, "b.txt"));
  await mkdir(join(a.directory, "nested"));
  await writeFile(join(a.directory, "nested", "new.txt"), "added without newline");
  bundle = await createTeamPatch({ ...setup, taskIds: ["a", "b"] });
  assert.deepEqual(bundle.files.find((file) => file.path === "a.txt").taskIds, ["a", "b"]);
  assert.match(renderTeamPatchDiff(bundle), /No newline at end of file/u);
  await assert.rejects(applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: "not-reviewed" }), /exact digest/u);
  await writeFile(join(setup.source, "b.txt"), "concurrent user change\n");
  await assert.rejects(applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest }), /Source changed/u);
  assert.equal(await readFile(join(setup.source, "a.txt"), "utf8"), "before-a\n", "later-file conflicts must prevent earlier writes");
  await writeFile(join(setup.source, "b.txt"), "before-b\n");
  await writeFile(join(b.directory, "b.txt"), "task changed after review\n");
  await assert.rejects(applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest }), /snapshot changed/u);
  await writeFile(join(b.directory, "b.txt"), "before-b\n");
  const applied = await applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest });
  assert.equal(applied.status, "applied", applied.detail);
  assert.equal(await readFile(join(setup.source, "a.txt"), "utf8"), "after-a\n");
  assert.equal(await readFile(join(setup.source, "nested", "new.txt"), "utf8"), "added without newline");
  await assert.rejects(readFile(join(setup.source, "b.txt")), { code: "ENOENT" });
  assert.equal((await applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest })).alreadyApplied, true);
});

test("partial application is durable unknown and is never automatically replayed or rolled back", async (t) => {
  const setup = await fixture(t);
  const task = await setup.workspaces.prepare("worker");
  await writeFile(join(task.directory, "a.txt"), "after-a\n");
  await writeFile(join(task.directory, "b.txt"), "after-b\n");
  const bundle = await createTeamPatch({ ...setup, taskIds: ["worker"] });
  const result = await applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest,
    onProgress() { throw new Error("simulated host failure after first durable result"); } });
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.appliedPaths, ["a.txt"], result.detail);
  assert.deepEqual(result.uncertainPaths, ["b.txt"]);
  assert.equal(await readFile(join(setup.source, "a.txt"), "utf8"), "after-a\n");
  assert.equal(await readFile(join(setup.source, "b.txt"), "utf8"), "before-b\n");
  assert.equal((await readTeamPatchApplication(setup.directory, bundle.id)).status, "unknown");
  assert.equal((await applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest })).status, "unknown");
  assert.equal(await readFile(join(setup.source, "b.txt"), "utf8"), "before-b\n", "unknown is evidence, not a retry instruction");
});

test("unsafe linked source or task files are rejected rather than treated as ordinary text changes", async (t) => {
  const setup = await fixture(t);
  const task = await setup.workspaces.prepare("worker");
  await writeFile(join(task.directory, "a.txt"), "after-a\n");
  const bundle = await createTeamPatch({ ...setup, taskIds: ["worker"] });
  const alias = join(setup.source, "alias.txt");
  await link(join(setup.source, "a.txt"), alias);
  await assert.rejects(applyTeamPatch({ ...setup, patchId: bundle.id, confirmDigest: bundle.digest }), /unsafe/u);
  assert.equal(await readFile(join(setup.source, "a.txt"), "utf8"), "before-a\n");
  await unlink(alias);
  await link(join(task.directory, "a.txt"), join(task.directory, "alias.txt"));
  await assert.rejects(createTeamPatch({ ...setup, taskIds: ["worker"] }), /hard-linked/u);
  await unlink(join(task.directory, "alias.txt"));
  await writeFile(join(task.directory, "a.txt"), "invisible\u001b[31mchange\n");
  await assert.rejects(createTeamPatch({ ...setup, taskIds: ["worker"] }), /display controls/u);
});
