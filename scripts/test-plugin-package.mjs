import { copyFile, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverWorkspacePackages,
  packWorkspacePackages,
  resolveConsumerTestDependencies,
  resolvePublishableRuntimeClosure,
  runCommand,
  runPnpm,
} from "./package-consumer-deps.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this check through pnpm test:package:plugin");
const destination = resolve(repository, "plugin-verification", `package-${Date.now()}`);
const packs = join(destination, "packs");
const consumer = resolve(repository, "..", "plugin-package-consumers", basename(destination));
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });
const actual = await realpath(destination);
if (relative(await realpath(repository), actual).startsWith(".."))
  throw new Error("Package verification path must stay in the worktree");
if (!relative(await realpath(repository), await realpath(consumer)).startsWith(".."))
  throw new Error("The packaged consumer must be outside the repository");

await runPnpm(pnpm, ["build"], repository);
const targets = [
  "@sortedyuan/may",
  "@sortedyuan/coordination",
  "@sortedyuan/mcp",
  "@sortedyuan/observability",
  "@sortedyuan/gateway",
];
const workspacePackages = await discoverWorkspacePackages(repository);
const required = resolvePublishableRuntimeClosure(workspacePackages, targets);
const { tarballs, overrides } = await packWorkspacePackages({
  packages: workspacePackages,
  names: required,
  packsDirectory: packs,
  repository,
  pnpm,
  consumer,
});

await copyFile(join(repository, "packages/may/test/plugin/consumer/package.json"), join(consumer, "package.json"));
await copyFile(
  join(repository, "packages/may/test/plugin/consumer/pnpm-workspace.yaml"),
  join(consumer, "pnpm-workspace.yaml"),
);
await runPnpm(
  pnpm,
  ["--dir", consumer, "config", "set", "overrides", JSON.stringify(overrides), "--json", "--location", "project"],
  consumer,
);
await runPnpm(pnpm, ["--dir", consumer, "add", ...tarballs, "--ignore-scripts"], consumer);
await copyFile(join(repository, "packages/may/test/plugin/consumer/index.mjs"), join(consumer, "index.mjs"));
await runCommand(process.execPath, [join(consumer, "index.mjs")], consumer);
await copyFile(join(repository, "README.md"), join(consumer, "README.md"));

const subpathTests = [
  "packages/may/test/services/models.test.mjs",
  "packages/may/test/services/runtime.test.mjs",
  "packages/may/test/services/permissions.test.mjs",
  "packages/may/test/services/skills.test.mjs",
  "packages/coordination/test/plugin.test.mjs",
  "packages/may/test/session/history-retrieval-tools.test.mjs",
];
const testDependencies = resolveConsumerTestDependencies(
  workspacePackages,
  required,
  subpathTests,
  repository,
  consumer,
);
await runPnpm(
  pnpm,
  ["--dir", consumer, "add", "--save-dev", ...testDependencies.values(), "--ignore-scripts"],
  consumer,
);
for (const path of subpathTests) {
  await mkdir(dirname(join(consumer, path)), { recursive: true });
  await copyFile(join(repository, path), join(consumer, path));
}
await runCommand(process.execPath, ["--test", ...subpathTests.map((path) => join(consumer, path))], consumer);
await copyFile(join(repository, "packages/may/test/plugin/consumer/subpaths.ts"), join(consumer, "subpaths.ts"));
await runCommand(
  process.execPath,
  [
    join(repository, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--target",
    "ES2022",
    "--types",
    "node",
    join(consumer, "subpaths.ts"),
  ],
  consumer,
);
console.log(`Verified ${targets.length} plugin packages and their ${required.length} packaged runtime dependencies`);
console.log(`External consumer: ${consumer}`);
