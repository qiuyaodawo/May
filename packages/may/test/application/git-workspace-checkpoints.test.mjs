import assert from "node:assert/strict";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  ProjectGitWorkspace,
  GitCheckpointError,
  GitWorkspaceConflictError,
} from "@sortedyuan/may/application/git-workspace";
import { commitTests, managed } from "./fixtures/git-workspace.mjs";

test(
  "initial and complete-round checkpoints preserve versions, exclusions and restart metadata",
  commitTests,
  async (t) => {
    const { options, workspace, manager, git } = await managed(t);
    await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
    await writeFile(join(workspace, ".env"), "TOKEN=fixture-value\n");
    await writeFile(join(workspace, ".gitignore"), "ignored/\n");
    await mkdir(join(workspace, "ignored"));
    await writeFile(join(workspace, "ignored", "build.txt"), "generated\n");
    const initial = await manager.prepare("session");
    assert.equal(initial.status, "committed");
    assert.equal((await git.log()).total, 1);
    assert.deepEqual((await git.status()).not_added, [".env"]);
    const lease = await manager.beginRound({ sessionId: "session" });
    await writeFile(join(workspace, "source.ts"), "export const value = 2;\n");
    await writeFile(join(workspace, "新增 source.ts"), "export const next = true;\n");
    await writeFile(join(workspace, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    const checkpoint = await lease.complete({
      outcome: "completed",
      runId: "final-run",
      runIds: ["earlier-run", "final-run"],
      historyPosition: 20,
    });
    assert.equal(checkpoint.status, "committed");
    assert.equal(checkpoint.fromCommit, initial.commit);
    assert.equal((await git.log()).total, 2);
    const diff = await manager.diff({ from: initial.commit, to: checkpoint.commit });
    assert.equal(diff.files.length, 3);
    assert.equal(diff.files.find((file) => file.path === "binary.bin").binary, true);
    assert.ok(diff.patch.includes("export const value = 2"));
    const resumed = await ProjectGitWorkspace.open(options);
    assert.equal((await resumed.checkpointByRun("session", "earlier-run")).id, checkpoint.id);
    const unchanged = await (
      await resumed.beginRound({ sessionId: "session", runId: "unchanged" })
    ).complete({ outcome: "completed" });
    assert.equal(unchanged.status, "unchanged");
    assert.equal(unchanged.commit, checkpoint.commit);
    assert.equal((await git.log()).total, 2);
    assert.equal((await git.revparse([`refs/may/checkpoints/${checkpoint.id}`])).trim(), checkpoint.commit);
    await rm(join(workspace, "新增 source.ts"));
    const deletion = await (
      await resumed.beginRound({ sessionId: "session", runId: "delete" })
    ).complete({ outcome: "completed" });
    const deletionDiff = await resumed.diff({ from: checkpoint.commit, to: deletion.commit });
    assert.equal(deletionDiff.deletions, 1);
  },
);

test(
  "restore validates the reviewed content and changes regular files without Git file restoration",
  commitTests,
  async (t) => {
    const { workspace, manager } = await managed(t);
    await writeFile(join(workspace, "source.ts"), "before\n");
    const initial = await manager.prepare("session");
    await writeFile(join(workspace, "source.ts"), "after\n");
    await writeFile(join(workspace, "new.ts"), "new\n");
    const preview = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.ts", "new.ts"] });
    await writeFile(join(workspace, "source.ts"), "manual change\n");
    await assert.rejects(
      manager.restore(preview),
      (error) => error instanceof GitWorkspaceConflictError && /changed after restoration preview/u.test(error.message),
    );
    assert.equal(await readFile(join(workspace, "new.ts"), "utf8"), "new\n");
    const updated = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.ts", "new.ts"] });
    assert.deepEqual(await manager.restore(updated), ["source.ts", "new.ts"]);
    assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "before\n");
    await assert.rejects(readFile(join(workspace, "new.ts")), { code: "ENOENT" });
  },
);

test("commit followed by metadata failure is recovered without a duplicate commit", commitTests, async (t) => {
  const { options, workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "persisted version\n");
  const records = join(options.dataRoot, manager.projectId, "checkpoints");
  await writeFile(records, "blocked metadata directory");
  await assert.rejects(manager.prepare("session"));
  assert.equal((await git.log()).total, 1);
  await rm(records);
  const reopened = await ProjectGitWorkspace.open(options);
  await reopened.prepare("session");
  assert.equal((await git.log()).total, 1);
  const checkpoints = await reopened.checkpoints("session");
  assert.equal(checkpoints.filter((checkpoint) => checkpoint.recovered === true).length, 1);
});

test("renamed and untracked text and binary files have structured diff entries", commitTests, async (t) => {
  const { workspace, manager } = await managed(t);
  await writeFile(join(workspace, "original source.ts"), "export const value = 1;\n");
  const initial = await manager.prepare("session");
  await rename(join(workspace, "original source.ts"), join(workspace, "renamed source.ts"));
  const renamed = await (
    await manager.beginRound({ sessionId: "session", runId: "rename" })
  ).complete({ outcome: "completed" });
  const versionDiff = await manager.diff({ from: initial.commit, to: renamed.commit });
  assert.equal(versionDiff.files[0].status, "renamed");
  assert.equal(versionDiff.files[0].previousPath, "original source.ts");
  assert.equal(versionDiff.files[0].path, "renamed source.ts");
  await writeFile(join(workspace, "new.ts"), "export const next = 2;\n");
  await writeFile(join(workspace, "new.bin"), Buffer.from([0, 2]));
  const workingDiff = await manager.diff({ from: renamed.commit });
  assert.equal(workingDiff.files.find((file) => file.path === "new.ts").status, "untracked");
  assert.ok(workingDiff.files.find((file) => file.path === "new.ts").patch.includes("export const next = 2"));
  assert.equal(workingDiff.files.find((file) => file.path === "new.bin").binary, true);
});

test("failed and cancelled rounds and disabled autoCommit preserve uncommitted edits", commitTests, async (t) => {
  const { workspace, options, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "initial\n");
  const initial = await manager.prepare("session");
  const failed = await manager.beginRound({ sessionId: "session", runId: "failed" });
  await writeFile(join(workspace, "source.ts"), "failed changes\n");
  assert.equal((await failed.complete({ outcome: "failed" })).status, "uncommitted");
  assert.equal((await git.log()).total, 1);
  const cancelled = await manager.beginRound({ sessionId: "session", runId: "cancelled" });
  assert.notEqual(cancelled.fromCommit, initial.commit);
  assert.equal(await git.show([`${cancelled.fromCommit}:source.ts`]), "failed changes\n");
  await writeFile(join(workspace, "source.ts"), "cancelled changes\n");
  assert.equal((await cancelled.complete({ outcome: "cancelled" })).commit, cancelled.fromCommit);
  const disabled = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  assert.equal((await disabled.prepare("disabled-session")).status, "uncommitted");
  assert.equal((await git.log()).total, 2);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "cancelled changes\n");
});

test("file restoration can save its resulting checkpoint under the same lease", commitTests, async (t) => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "initial\n");
  const initial = await manager.prepare("session");
  const round = await manager.beginRound({ sessionId: "session", runId: "changes" });
  await writeFile(join(workspace, "source.ts"), "next\n");
  await round.complete({ outcome: "completed" });
  const preview = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.ts"] });
  const checkpoint = await manager.restore(preview, { sessionId: "session", runId: "restore" });
  assert.equal(checkpoint.status, "committed");
  assert.equal((await git.log()).total, 3);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "initial\n");
});

test(
  "pre-commit Hook failure preserves staged files and can be corrected without duplicate commits",
  commitTests,
  async (t) => {
    const { workspace, manager, git } = await managed(t);
    await writeFile(join(workspace, "source.ts"), "version\n");
    const hook = join(workspace, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    await assert.rejects(manager.prepare("session"), GitCheckpointError);
    assert.equal((await manager.status()).commit, undefined);
    assert.ok((await git.status()).staged.includes("source.ts"));
    await rm(hook);
    const resumed = await manager.beginRound({ sessionId: "session", runId: "run" });
    assert.equal(resumed.fromCommit, (await manager.status()).commit);
    assert.equal((await resumed.complete({ outcome: "completed" })).status, "unchanged");
    assert.equal((await git.log()).total, 1);
  },
);

test("a failed dirty baseline is saved before the repaired Session starts another round", commitTests, async (t) => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "repository version\n");
  await manager.prepare("seed");
  await writeFile(join(workspace, "source.ts"), "initial manual version\n");
  const hook = join(workspace, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await assert.rejects(manager.prepare("session"), GitCheckpointError);
  assert.equal((await manager.checkpoints("session"))[0].status, "failed");
  await rm(hook);
  const resumed = await manager.beginRound({ sessionId: "session", runId: "run" });
  assert.equal((await git.log()).total, 2);
  assert.equal(await git.show([`${resumed.fromCommit}:source.ts`]), "initial manual version\n");
  await writeFile(join(workspace, "source.ts"), "agent version\n");
  const checkpoint = await resumed.complete({ outcome: "completed" });
  assert.equal(checkpoint.fromCommit, resumed.fromCommit);
  assert.equal((await git.log()).total, 3);
  const diff = await manager.diff({ from: checkpoint.fromCommit, to: checkpoint.commit });
  assert.ok(diff.patch.includes("-initial manual version"));
  assert.ok(diff.patch.includes("+agent version"));
});

test("repository identity drift reports an error before following an ancestor", async (t) => {
  const { workspace, manager } = await managed(t);
  await rename(join(workspace, ".git"), join(workspace, ".git-hidden"));
  await assert.rejects(manager.status(), /repository identity changed/);
  await assert.rejects(manager.beginRound({ sessionId: "session" }), /repository identity changed/);
});

test(
  "file restoration recovers an applied pending checkpoint before recording its own commit",
  commitTests,
  async (t) => {
    const { workspace, options, manager, git } = await managed(t);
    await writeFile(join(workspace, "source.txt"), "initial\n");
    const initial = await manager.prepare("session");
    const round = await manager.beginRound({ sessionId: "session", runId: "pending" });
    await writeFile(join(workspace, "source.txt"), "applied pending version\n");
    const records = join(options.dataRoot, manager.projectId, "checkpoints");
    const savedRecords = `${records}-saved`;
    await rename(records, savedRecords);
    await writeFile(records, "blocked metadata directory");
    await assert.rejects(round.complete({ outcome: "completed" }), GitCheckpointError);
    assert.equal((await git.log()).total, 2);
    await rm(records);
    await rename(savedRecords, records);
    const preview = await manager.previewRestore({ checkpointId: initial.id, paths: ["source.txt"] });
    assert.equal((await manager.restore(preview, { sessionId: "session", runId: "restore" })).status, "committed");
    const recovered = await manager.checkpointByRun("session", "pending");
    assert.equal(recovered.status, "committed");
    assert.equal(recovered.recovered, true);
    assert.equal((await git.log()).total, 3);
  },
);
