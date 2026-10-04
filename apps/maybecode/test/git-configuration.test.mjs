import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { homedir } from "node:os";
import { loadMayConfig } from "@may/config";
import { resolveMaybeCodeGit } from "../dist/index.js";

const artifacts = fileURLToPath(new URL("../../../review/git-configuration/", import.meta.url));

test("project Git configuration defaults, path resolution and explicit controls use the saved config", async t => {
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "config-"));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${resolve(artifacts)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "config.json");
  const read = async git => {
    await writeFile(path, JSON.stringify({ providers: {}, models: {}, apps: { maybecode: git === undefined ? {} : { git } } }));
    return resolveMaybeCodeGit(await loadMayConfig({ path }));
  };
  assert.deepEqual(await read(undefined), {});
  assert.equal(await read(false), false);
  assert.deepEqual(await read({ worktreesRoot: "~/.may/worktrees" }), { worktreesRoot: join(homedir(), ".may", "worktrees") });
  assert.deepEqual(await read({ autoCommit: false, readOnly: true, dataRoot: "./records", worktreesRoot: "./worktrees", excludedPaths: ["private"] }), {
    autoCommit: false, readOnly: true, dataRoot: resolve(dirname(path), "records"),
    worktreesRoot: resolve(dirname(path), "worktrees"), excludedPaths: ["private"],
  });
  for (const git of [true, [], { autoCommit: "true" }, { readOnly: 1 }, { worktreesRoot: "" }, { dataRoot: 2 }, { excludedPaths: "private" }, { excludedPaths: [1] }, { unknown: true }]) {
    await assert.rejects(read(git), /apps\.maybecode\.git/u);
  }
});
