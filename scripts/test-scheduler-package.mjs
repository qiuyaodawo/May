import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this check through pnpm test:package:scheduler");
const destination = resolve(repository, "scheduler-verification", `package-${Date.now()}`);
const packs = join(destination, "packs");
const consumer = resolve(repository, "..", "scheduler-package-consumers", `consumer-${Date.now()}`);
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });
if (relative(await realpath(repository), await realpath(destination)).startsWith("..")) throw new Error("Package output must stay in the worktree");
if (!relative(await realpath(repository), await realpath(consumer)).startsWith("..")) throw new Error("The consumer must be outside the repository");

await runPnpm(["--filter", "@may/scheduler", "build"], repository);
const packages = ["@may/scheduler"];
const { version } = JSON.parse(await readFile(join(repository, "packages/scheduler/package.json"), "utf8"));
for (const name of packages) await runPnpm(["--filter", name, "pack", "--pack-destination", packs], repository);
await copyFile(join(repository, "packages/scheduler/test/consumer/package.json"), join(consumer, "package.json"));
await copyFile(join(repository, "packages/scheduler/test/consumer/index.mjs"), join(consumer, "index.mjs"));
await runPnpm(["add", join(packs, `may-scheduler-${version}.tgz`), "--ignore-scripts"], consumer);
await run(process.execPath, [join(consumer, "index.mjs")], consumer);
console.log(`Verified ${packages.join(", ")} and its installed runtime dependencies`);
console.log(`External consumer: ${consumer}`);

function runPnpm(args, cwd) {
  return /\.[cm]?js$/iu.test(pnpm)
    ? run(process.execPath, [pnpm, ...args], cwd)
    : run(pnpm, args, cwd);
}

async function run(executable, args, cwd) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`Package check exited with ${code}`)));
  });
}
