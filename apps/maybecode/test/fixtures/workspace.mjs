import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestDirectory } from "@sortedyuan/test-support";

export async function createTestWorkspace(t) {
  const directory = await createTestDirectory(t, "maybecode/workspace");
  await promisify(execFile)("git", ["init", directory], { windowsHide: true });
  return directory;
}
