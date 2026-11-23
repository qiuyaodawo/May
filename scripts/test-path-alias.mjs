import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, rmdir, symlink, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNodeTestArgs } from "./run-node-tests.mjs";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const smoke = args.includes("--smoke");
const unknown = args.filter((arg) => arg !== "--smoke");
if (unknown.length > 0) {
  throw new Error(`Unknown test-path-alias arguments: ${unknown.join(", ")}`);
}

const pnpm = process.env.npm_execpath;
if (!smoke && (!pnpm || !basename(pnpm).toLowerCase().includes("pnpm"))) {
  throw new Error("Run this test through pnpm test:path-alias");
}
const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(repository, ".test-output");
await mkdir(output, { recursive: true });
const parent = await realpath(await mkdtemp(join(output, "path-alias-")));
const target = join(parent, "target");
const alias = join(parent, "alias");
let linked = false;

const SMOKE_TESTS = [
  "scripts/test-path-alias-smoke.test.mjs",
  "packages/tools/coding-tools/test/coding-tools.test.mjs",
  "packages/tools/coding-tools/test/instructions.test.mjs",
  "packages/tools/coding-tools/test/workspace-path.invariants.test.mjs",
  "packages/may/test/storage/file-access.test.mjs",
];

function spawnChecked(executable, spawnArgs, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, spawnArgs, {
      cwd: repository,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
}

try {
  await mkdir(target);
  await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
  linked = true;
  assert.notEqual(alias, await realpath(alias), "The test needs a non-canonical temporary path");
  const env = {
    ...process.env,
    TEMP: alias,
    TMP: alias,
    TMPDIR: alias,
    MAY_TEST_OUTPUT_ROOT: alias,
  };
  if (smoke) {
    console.log("Running path-alias smoke tests with an aliased temporary & test-output directory");
    process.exitCode = await spawnChecked(process.execPath, buildNodeTestArgs(SMOKE_TESTS, env), env);
  } else {
    console.log("Running all workspace tests with an aliased temporary & test-output directory");
    const script = /\.[cm]?js$/iu.test(pnpm);
    process.exitCode = await spawnChecked(
      script ? process.execPath : pnpm,
      script ? [pnpm, "run", "test"] : ["run", "test"],
      env,
    );
  }
} finally {
  // Unlink only the alias; recursively remove only the dedicated physical target.
  if (linked) await unlink(alias);
  assert.equal(dirname(target), parent);
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rmdir(parent);
}
