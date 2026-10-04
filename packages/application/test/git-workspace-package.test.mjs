import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifacts = join(repository, "review", "git-workspace-package-tests");

test("packed Git workspace subpath installs and runs in an independent consumer", {
  skip: process.env.MAY_GIT_PACKAGE_TEST !== "1" || process.env.MAY_GIT_CHECKPOINT_TEST_COMMITS !== "1",
  timeout: 120_000,
}, async t => {
  const pnpm = process.env.npm_execpath;
  assert.ok(pnpm, "Run this check through pnpm --filter @may/application test:package");
  assert.equal((await runPnpm(pnpm, ["--version"], repository)).trim(), "12.4.2");
  await mkdir(artifacts, { recursive: true });
  const directory = await mkdtemp(join(artifacts, "consumer-"));
  t.after(async () => { assert.ok(resolve(directory).startsWith(`${artifacts}\\`) || resolve(directory).startsWith(`${artifacts}/`)); await rm(directory, { recursive: true, force: true }); });
  const packs = join(directory, "packs");
  const consumer = join(directory, "consumer");
  await mkdir(packs);
  await mkdir(consumer);
  const packed = JSON.parse(await runPnpm(pnpm, ["--filter", "@may/application...", "pack", "--pack-destination", packs, "--json"], repository));
  assert.ok(Array.isArray(packed));
  const application = packed.find(entry => entry.name === "@may/application");
  assert.ok(application.files.some(file => file.path === "dist/git-workspace.js"));
  assert.ok(application.files.some(file => file.path === "dist/git-workspace.d.ts"));
  assert.ok(application.files.every(file => !file.path.startsWith("test/") && !file.path.endsWith(".tsbuildinfo")));
  const overrides = Object.fromEntries(packed.map(entry => [entry.name,
    `file:${relative(consumer, join(packs, `${entry.name.replace(/^@/u, "").replaceAll("/", "-")}-${entry.version}.tgz`)).replaceAll("\\", "/")}`]));
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({ name: "git-workspace-package-consumer", private: true,
    type: "module", dependencies: { "@may/application": overrides["@may/application"] } }, null, 2)}\n`);
  await writeFile(join(consumer, "pnpm-workspace.yaml"), `packages:\n  - "."\noverrides:\n${Object.entries(overrides)
    .map(([name, path]) => `  ${JSON.stringify(name)}: ${JSON.stringify(path)}`).join("\n")}\n`);
  const store = (await runPnpm(pnpm, ["store", "path"], repository)).trim();
  await runPnpm(pnpm, ["install", "--offline", "--ignore-scripts", "--store-dir", store], consumer);
  const installed = JSON.parse(await readFile(join(consumer, "node_modules", "@may", "application", "package.json"), "utf8"));
  assert.equal(installed.dependencies["simple-git"], "^4.0.2");
  assert.equal(installed.dependencies.diff, "9.0.0");
  assert.ok(Object.values(installed.dependencies).every(value => !value.startsWith("workspace:")));
  await copyFile(join(repository, "packages", "application", "test", "consumer", "git-workspace.mjs"), join(consumer, "check.mjs"));
  assert.match(await run(process.execPath, ["check.mjs"], consumer), /Packed Git workspace verification passed/u);
});

function runPnpm(pnpm, args, cwd) {
  return /\.[cm]?js$/iu.test(pnpm) ? run(process.execPath, [pnpm, ...args], cwd) : run(pnpm, args, cwd);
}

function run(executable, args, cwd) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", value => { output += value; });
    child.stderr.on("data", value => { errors += value; });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolveResult(output) : reject(new Error(`Package check ${args.join(" ")} exited ${code}: ${output}${errors}`)));
  });
}
