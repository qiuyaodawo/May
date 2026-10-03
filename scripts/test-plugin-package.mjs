import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this check through pnpm test:package:plugin");
const destination = resolve(repository, "plugin-verification", `package-${Date.now()}`);
const packs = join(destination, "packs");
const consumer = resolve(repository, "..", "plugin-package-consumers", basename(destination));
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });
const actual = await realpath(destination);
if (relative(await realpath(repository), actual).startsWith("..")) throw new Error("Package verification path must stay in the worktree");
if (!relative(await realpath(repository), await realpath(consumer)).startsWith("..")) throw new Error("The packaged consumer must be outside the repository");
await runPnpm(["build"], repository);
const targets = ["@may/plugin", "@may/plugin-services", "@may/plugin-runtime", "@may/plugin-models", "@may/plugin-permissions", "@may/plugin-skills",
  "@may/plugin-goals", "@may/plugin-history-memory", "@may/plugin-delegation", "@may/plugin-mcp", "@may/plugin-observability",
  "@may/plugin-delivery", "@may/plugin-channel-telegram", "@may/plugin-channel-feishu", "@may/plugin-agent-adapters", "@may/plugin-coordination", "@may/plugin-web-api"];
const manifests = new Map();
for (const group of ["packages", "packages/providers", "packages/tools", "packages/ui", "packages/plugins"]) {
  for (const entry of await readdir(join(repository, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(repository, group, entry.name);
    if (!(await readdir(directory)).includes("package.json")) continue;
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    manifests.set(manifest.name, manifest);
  }
}
const required = new Set();
function include(name) {
  if (required.has(name)) return;
  const manifest = manifests.get(name);
  if (!manifest || manifest.private) throw new Error(`Runtime dependency is not a public package: ${name}`);
  required.add(name);
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })) {
    if (dependency.startsWith("@may/")) include(dependency);
  }
}
targets.forEach(include);
for (const name of required) {
  await runPnpm(["--filter", name, "pack", "--pack-destination", packs], repository);
}
const tarballs = (await readdir(packs)).filter((name) => name.endsWith(".tgz")).map((name) => join(packs, name));
await copyFile(join(repository, "packages/plugin/test/consumer/package.json"), join(consumer, "package.json"));
await copyFile(join(repository, "packages/plugin/test/consumer/pnpm-workspace.yaml"), join(consumer, "pnpm-workspace.yaml"));
const overrides = Object.fromEntries([...required].map(name => {
  const tarball = tarballs.find(path => basename(path) === `${name.replace("@", "").replace("/", "-")}-${manifests.get(name).version}.tgz`);
  if (!tarball) throw new Error(`Packed runtime dependency is missing: ${name}`);
  return [name, `file:${relative(consumer, tarball).replaceAll("\\", "/")}`];
}));
await runPnpm(["--dir", consumer, "config", "set", "overrides", JSON.stringify(overrides),
  "--json", "--location", "project"], consumer);
await runPnpm(["--dir", consumer, "add", ...tarballs, "--ignore-scripts"], consumer);
await copyFile(join(repository, "packages/plugin/test/consumer/index.mjs"), join(consumer, "index.mjs"));
await run(process.execPath, [join(consumer, "index.mjs")], consumer);
console.log(`Verified ${targets.length} plugin packages and their ${required.size} packaged runtime dependencies`);
console.log(`External consumer: ${consumer}`);

function runPnpm(args, cwd, env = process.env) {
  return /\.[cm]?js$/iu.test(pnpm)
    ? run(process.execPath, [pnpm, ...args], cwd, env)
    : run(pnpm, args, cwd, env);
}

async function run(executable, args, cwd, env = process.env) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? accept() : reject(new Error(`Package check command exited with ${code}`)));
  });
}
