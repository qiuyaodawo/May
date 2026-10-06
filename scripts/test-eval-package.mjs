import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run through pnpm test:package:eval");
const output = resolve(repository, "eval-verification", `package-${Date.now()}`);
const packs = join(output, "packs");
const consumer = resolve(repository, "..", "eval-package-consumers", `consumer-${Date.now()}`);
await mkdir(packs, { recursive: true });
await mkdir(consumer, { recursive: true });
if (!relative(await realpath(repository), await realpath(consumer)).startsWith("..")) throw new Error("Consumer must be outside repository");
const releaseNames = ["@may/core", "@may/context", "@may/session", "@may/session-tools", "@may/permissions", "@may/skills", "@may/plugin",
  "@may/plugin-services", "@may/plugin-models", "@may/plugin-runtime", "@may/plugin-permissions", "@may/plugin-skills",
  "@may/application", "@may/coordination", "@may/observability", "@may/eval"];
const manifests = new Map();
async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => entry.name === "package.json")) {
    const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    manifests.set(manifest.name, { directory, manifest });
    return;
  }
  for (const entry of entries) if (entry.isDirectory() && entry.name !== "node_modules") await discover(join(directory, entry.name));
}
await discover(join(repository, "packages"));
const visited = new Set();
function visit(name) {
  if (visited.has(name)) return;
  const value = manifests.get(name);
  if (!value || value.manifest.private) throw new Error(`Missing publishable dependency: ${name}`);
  visited.add(name);
  for (const dependency of Object.keys(value.manifest.dependencies ?? {})) if (dependency.startsWith("@may/")) visit(dependency);
}
visit("@may/eval");
if (visited.size !== releaseNames.length || releaseNames.some(name => !visited.has(name))) throw new Error("Eval runtime dependencies differ from the explicit package list");
await runPnpm(["--filter", "@may/eval", "build"], repository);
const overrides = {};
for (const name of releaseNames) {
  const value = manifests.get(name);
  await runPnpm(["--filter", name, "pack", "--pack-destination", packs], repository);
  overrides[name] = `file:${join(packs, `${name.replace("@", "").replace("/", "-")}-${value.manifest.version}.tgz`).replaceAll("\\", "/")}`;
}
await copyFile(join(repository, "packages/eval/test/consumer/package.json"), join(consumer, "package.json"));
await copyFile(join(repository, "packages/eval/test/consumer/index.mjs"), join(consumer, "index.mjs"));
await runPnpm(["config", "set", "overrides", JSON.stringify(overrides), "--json", "--location", "project"], consumer);
await runPnpm(["add", overrides["@may/eval"], "--ignore-scripts"], consumer);
await run(process.execPath, [join(consumer, "index.mjs")], consumer);
console.log(`Verified ${releaseNames.length} explicit packed runtime packages; consumer ${consumer}`);
function runPnpm(args, cwd) { return /\.[cm]?js$/iu.test(pnpm) ? run(process.execPath, [pnpm, ...args], cwd) : run(pnpm, args, cwd); }
async function run(executable, args, cwd) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? accept() : reject(new Error(`Package check exited with ${code}`)));
  });
}
