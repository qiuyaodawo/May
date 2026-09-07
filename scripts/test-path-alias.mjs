import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pnpm = process.env.npm_execpath;
if (!pnpm || !basename(pnpm).toLowerCase().includes("pnpm")) {
  throw new Error("Run this test through pnpm test:path-alias");
}
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const parent = await realpath(await mkdtemp(join(tmpdir(), "may-test-path-alias-")));
const target = join(parent, "target");
const alias = join(parent, "alias");
let linked = false;
try {
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  linked = true;
  assert.notEqual(alias, await realpath(alias), "The test needs a non-canonical temporary path");
  console.log("Running all workspace tests with an aliased temporary directory");
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [pnpm, "run", "test"], {
      cwd: repository,
      env: { ...process.env, TEMP: alias, TMP: alias, TMPDIR: alias },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
} finally {
  // Unlink only the alias; recursively remove only the dedicated physical target.
  if (linked) await unlink(alias);
  assert.equal(dirname(target), parent);
  await rm(target, { recursive: true, force: true });
  await rmdir(parent);
}
