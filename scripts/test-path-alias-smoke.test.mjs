import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { createTestDirectory, testOutputRoot } from "../packages/test-support/index.mjs";
import { acquireFileLock, withFileAccess } from "@sortedyuan/may/storage";
import { resolveExistingWorkspacePath, resolveWritableWorkspacePath } from "@sortedyuan/coding-tools";

test("path-alias smoke passes a real non-canonical alias directly into coding-tools and storage APIs", async (t) => {
  const canonicalRoot = await realpath(testOutputRoot);
  assert.notEqual(
    testOutputRoot,
    canonicalRoot,
    "MAY_TEST_OUTPUT_ROOT must be a non-canonical alias path distinct from realpath()",
  );

  const aliasedWorkspace = await createTestDirectory(t, "path-alias-direct");
  const canonicalWorkspace = await realpath(aliasedWorkspace);
  assert.notEqual(aliasedWorkspace, canonicalWorkspace, "createTestDirectory must preserve the alias prefix");

  const existingFile = join(aliasedWorkspace, "hello.txt");
  await writeFile(existingFile, "ok", "utf8");

  const resolvedExisting = await resolveExistingWorkspacePath(aliasedWorkspace, "hello.txt");
  assert.equal(resolvedExisting.absolute, join(canonicalWorkspace, "hello.txt"));
  assert.equal(resolvedExisting.relative, "hello.txt");

  const resolvedWritable = await resolveWritableWorkspacePath(aliasedWorkspace, "nested/new.txt");
  assert.equal(resolvedWritable.absolute, join(canonicalWorkspace, "nested", "new.txt"));
  assert.equal(resolvedWritable.relative, "nested/new.txt");

  const resolvedAbsExisting = await resolveExistingWorkspacePath(aliasedWorkspace, existingFile);
  assert.equal(resolvedAbsExisting.absolute, join(canonicalWorkspace, "hello.txt"));
  assert.equal(resolvedAbsExisting.relative, "hello.txt");

  const resolvedAbsWritable = await resolveWritableWorkspacePath(
    aliasedWorkspace,
    join(aliasedWorkspace, "nested", "abs-new.txt"),
  );
  assert.equal(resolvedAbsWritable.absolute, join(canonicalWorkspace, "nested", "abs-new.txt"));
  assert.equal(resolvedAbsWritable.relative, "nested/abs-new.txt");

  await assert.rejects(resolveWritableWorkspacePath(aliasedWorkspace, join(dirname(aliasedWorkspace), "escape.txt")), {
    code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
  });

  const lockFile = join(aliasedWorkspace, "state.lock");
  const lock = await acquireFileLock(lockFile);
  try {
    await lock.assertHeld();
  } finally {
    await lock.release();
  }

  const value = await withFileAccess(join(aliasedWorkspace, "data.json"), "exclusive", async () => "locked-ok");
  assert.equal(value, "locked-ok");
});
