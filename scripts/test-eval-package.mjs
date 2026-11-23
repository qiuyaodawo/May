import { copyFile, mkdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputRoot } from "../packages/test-support/index.mjs";
import {
  discoverWorkspacePackages,
  packWorkspacePackages,
  resolvePublishableRuntimeClosure,
  runCommand,
  runPnpm,
} from "./package-consumer-deps.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run through pnpm test:package:eval");
const output = join(testOutputRoot, "eval-package", String(Date.now()));
const packs = join(output, "packs");
const consumer = resolve(repository, "..", "eval-package-consumers", `consumer-${Date.now()}`);
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });
if (!relative(await realpath(repository), await realpath(consumer)).startsWith(".."))
  throw new Error("Consumer must be outside repository");

const packages = await discoverWorkspacePackages(repository);
const releaseNames = resolvePublishableRuntimeClosure(packages, ["@sortedyuan/eval"]);

await runPnpm(pnpm, ["--filter", "@sortedyuan/eval", "build"], repository);
const { overrides } = await packWorkspacePackages({
  packages,
  names: releaseNames,
  packsDirectory: packs,
  repository,
  pnpm,
});

await copyFile(join(repository, "packages/eval/test/consumer/package.json"), join(consumer, "package.json"));
await copyFile(join(repository, "packages/eval/test/consumer/index.mjs"), join(consumer, "index.mjs"));
await runPnpm(
  pnpm,
  ["config", "set", "overrides", JSON.stringify(overrides), "--json", "--location", "project"],
  consumer,
);
await runPnpm(pnpm, ["add", overrides["@sortedyuan/eval"], "--ignore-scripts"], consumer);
await runCommand(process.execPath, [join(consumer, "index.mjs")], consumer);
console.log(`Verified ${releaseNames.length} derived packed runtime packages; consumer ${consumer}`);
