import assert from "node:assert/strict";
import { testOutputRoot } from "@sortedyuan/test-support";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export async function workspaceFor(t, label) {
  const base = join(testOutputRoot, "maybecode", "plugins");
  await mkdir(base, { recursive: true });
  const workspace = await mkdtemp(join(base, label));
  t.after(async () => {
    assert.ok(resolve(workspace).startsWith(resolve(base) + sep));
    await rm(workspace, { recursive: true, force: true });
  });
  await writeFile(join(workspace, "README.md"), await readFile(new URL("../../../../README.md", import.meta.url)));
  return workspace;
}
