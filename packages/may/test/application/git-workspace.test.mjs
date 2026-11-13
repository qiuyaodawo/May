import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { ProjectGitWorkspace, GitCheckpointError } from "@sortedyuan/may/application/git-workspace";
import { commitTests, fixture, managed } from "./fixtures/git-workspace.mjs";

test("read-only and disabled Git management leave an unmanaged project unchanged", async (t) => {
  const { workspace, options } = await fixture(t);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = resolve(workspace, "..").replaceAll("\\", "/");
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  });
  const readonly = await ProjectGitWorkspace.open({ ...options, readOnly: true });
  assert.equal((await readonly.status()).state, "unmanaged");
  const disabled = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  assert.equal((await disabled.status()).state, "unmanaged");
  assert.deepEqual(await readdir(workspace), ["source.ts"]);
});

test("initialization reports an unborn branch without creating a commit", async (t) => {
  const { manager } = await managed(t);
  const status = await manager.status();
  assert.equal(status.state, "unborn");
  assert.equal(status.commit, undefined);
  assert.equal(status.detached, false);
});

test("read-only preparation preserves an existing empty metadata directory", async (t) => {
  const { options, git } = await fixture(t);
  await git.init();
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const directory = join(options.dataRoot, manager.projectId);
  const observer = await ProjectGitWorkspace.open({ ...options, autoCommit: false, readOnly: true });
  assert.equal((await observer.prepare("readonly-session")).status, "uncommitted");
  const round = await observer.beginRound({ sessionId: "readonly-session" });
  await round.close();
  assert.deepEqual(await readdir(directory), []);
});

test("checkpoint inspection coordinates with concurrent metadata updates", async (t) => {
  const { options, git } = await fixture(t);
  await git.init();
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const checkpoint = await manager.prepare("concurrent-session");
  assert.equal(checkpoint.commit, undefined);
  const observer = await ProjectGitWorkspace.open({ ...options, autoCommit: false, readOnly: true });
  const readers = Array.from({ length: 8 }, async () => {
    for (let index = 0; index < 80; index++) {
      const [value] = await observer.checkpoints("concurrent-session");
      assert.equal(value.id, checkpoint.id);
      assert.equal((await observer.checkpoint(checkpoint.id)).status, "uncommitted");
    }
  });
  const updates = (async () => {
    for (let position = 1; position <= 40; position++) await manager.bindCheckpoint(checkpoint.id, position);
  })();
  const results = await Promise.allSettled([...readers, updates]);
  for (const result of results) assert.equal(result.status, "fulfilled", result.reason?.stack);
  assert.equal((await observer.checkpoint(checkpoint.id)).historyPosition, 40);
  assert.equal((await observer.status()).commit, undefined);
});

test("read-only checkpoint inspection requires initialized access files without creating them", async (t) => {
  const { options, git } = await fixture(t);
  await git.init();
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const checkpoint = await manager.prepare("existing-records");
  const path = join(options.dataRoot, manager.projectId, "checkpoints", `${checkpoint.id}.json`);
  await rm(`${path}.access`);
  await rm(`${path}.access.gate`);
  const observer = await ProjectGitWorkspace.open({ ...options, autoCommit: false, readOnly: true });
  await assert.rejects(observer.checkpoint(checkpoint.id), { code: "FILE_ACCESS_NOT_INITIALIZED" });
  assert.deepEqual(await readdir(join(options.dataRoot, manager.projectId, "checkpoints")), [`${checkpoint.id}.json`]);
  await manager.checkpoints();
  assert.deepEqual(await observer.checkpoint(checkpoint.id), checkpoint);
});

test("automatic management initializes a genuinely unmanaged project", commitTests, async (t) => {
  const { workspace, options, git } = await fixture(t);
  const previous = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = resolve(workspace, "..").replaceAll("\\", "/");
  t.after(() => {
    if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = previous;
  });
  const manager = await ProjectGitWorkspace.open(options);
  assert.equal(await git.revparse(["--show-toplevel"]), workspace.replaceAll("\\", "/"));
  await git.addConfig("user.name", "May integration test");
  await git.addConfig("user.email", "may-test@example.invalid");
  await git.addConfig("core.autocrlf", "false");
  await writeFile(join(workspace, "source.ts"), "initial version\n");
  const initial = await manager.prepare("session");
  assert.equal(initial.status, "committed");
  assert.equal((await git.log()).total, 1);
});

test("rejected authorization preserves working files and index", async (t) => {
  const { workspace, options, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const manager = await ProjectGitWorkspace.open({ ...options, authorizeCommit: () => false });
  await assert.rejects(manager.prepare("session"), GitCheckpointError);
  assert.equal((await git.status()).staged.length, 0);
  assert.equal((await manager.status()).commit, undefined);
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "export const value = 1;\n");
  assert.equal((await manager.checkpoints("session"))[0].status, "failed");
});

test("divergent staged and working versions fail without changing the index", async (t) => {
  const { workspace, manager, git } = await managed(t);
  await writeFile(join(workspace, "source.ts"), "staged\n");
  await git.add("source.ts");
  await writeFile(join(workspace, "source.ts"), "working\n");
  await assert.rejects(manager.prepare("session"), /Staged and working content differ/);
  assert.equal(await git.show([":source.ts"]), "staged\n");
  assert.equal(await readFile(join(workspace, "source.ts"), "utf8"), "working\n");
});

test("workspace lease rejects simultaneous writers and releases after cancellation", async (t) => {
  const { options } = await managed(t);
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const first = await manager.beginRound({ sessionId: "first" });
  await assert.rejects(manager.beginRound({ sessionId: "second" }), /already in use/);
  const checkpoint = await first.complete({ outcome: "cancelled" });
  assert.equal(checkpoint.status, "uncommitted");
  const second = await manager.beginRound({ sessionId: "second" });
  await second.close();
});

test("real child-process leases block competing writers and recover after process exit", async (t) => {
  const { options } = await managed(t);
  const manager = await ProjectGitWorkspace.open({ ...options, autoCommit: false });
  const child = fork(
    fileURLToPath(new URL("./git-workspace-lock-child.mjs", import.meta.url)),
    [JSON.stringify({ ...options, autoCommit: false })],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill();
  });
  await new Promise((resolveReady, reject) => {
    child.once("message", resolveReady);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Lease child exited before readiness: ${code}`)));
  });
  await assert.rejects(manager.beginRound({ sessionId: "competing" }), /already in use/);
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGKILL");
  await exited;
  const recovered = await manager.beginRound({ sessionId: "recovered" });
  await assert.rejects(manager.beginRound({ sessionId: "still-competing" }), /already in use/);
  await recovered.close();
});
