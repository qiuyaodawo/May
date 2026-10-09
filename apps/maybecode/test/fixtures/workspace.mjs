import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export async function createTestWorkspace(t) {
  const parent = resolve("review", "maybecode-application");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "workspace-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await promisify(execFile)("git", ["init", directory], { windowsHide: true });
  return directory;
}
