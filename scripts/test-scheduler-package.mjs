import { copyFile, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverWorkspacePackages,
  packWorkspacePackages,
  resolvePublishableRuntimeClosure,
  runCommand,
  runPnpm,
} from "./package-consumer-deps.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this check through pnpm test:package:scheduler");
const destination = resolve(repository, "scheduler-verification", `package-${Date.now()}`);
const packs = join(destination, "packs");
const consumer = resolve(repository, "..", "scheduler-package-consumers", `consumer-${Date.now()}`);
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });
if (relative(await realpath(repository), await realpath(destination)).startsWith(".."))
  throw new Error("Package output must stay in the worktree");
if (!relative(await realpath(repository), await realpath(consumer)).startsWith(".."))
  throw new Error("The consumer must be outside the repository");

await runPnpm(pnpm, ["--filter", "@sortedyuan/scheduler", "build"], repository);
const workspacePackages = await discoverWorkspacePackages(repository);
const requiredNames = resolvePublishableRuntimeClosure(workspacePackages, ["@sortedyuan/scheduler"]);
const { tarballs, overrides } = await packWorkspacePackages({
  packages: workspacePackages,
  names: requiredNames,
  packsDirectory: packs,
  repository,
  pnpm,
});

await copyFile(join(repository, "packages/scheduler/test/consumer/package.json"), join(consumer, "package.json"));
await copyFile(join(repository, "packages/scheduler/test/consumer/index.mjs"), join(consumer, "index.mjs"));
await runPnpm(
  pnpm,
  ["config", "set", "overrides", JSON.stringify(overrides), "--json", "--location", "project"],
  consumer,
);
await runPnpm(pnpm, ["add", ...tarballs, "--ignore-scripts"], consumer);
await runCommand(process.execPath, [join(consumer, "index.mjs")], consumer);
console.log(`Verified ${requiredNames.join(", ")} and its installed runtime dependencies`);
console.log(`External consumer: ${consumer}`);
