import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tar";
import semver from "semver";
import { checkRelease, releaseNames, repository, runPnpm } from "./release-utils.mjs";

const args = process.argv.slice(2).filter(argument => argument !== "--");
assert.equal(args.length, 2, "Usage: pnpm test:package:release -- --directory <external-parent>");
assert.equal(args[0], "--directory");
const parent = resolve(args[1]);
await mkdir(parent, { recursive: true });
const parentPath = await realpath(parent);
const pathFromRepository = relative(await realpath(repository), parentPath);
assert.ok(pathFromRepository === ".." || pathFromRepository.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(pathFromRepository), "The consumer must be outside the repository");
const output = join(repository, "review", "release-packages", String(Date.now()));
const packs = join(output, "packs");
const consumer = join(parentPath, `release-consumer-${Date.now()}`);
await mkdir(packs, { recursive: true });
await mkdir(consumer);
const manifests = await checkRelease();
for (const name of releaseNames) {
  const packageDirectory = await realpath(manifests.get(name).directory);
  const packageRelative = relative(await realpath(repository), packageDirectory);
  assert.ok(packageRelative && !isAbsolute(packageRelative) && !packageRelative.startsWith(".."), `${name}: build output must stay in the repository`);
  await rm(join(packageDirectory, "dist"), { recursive: true, force: true });
}
runPnpm(["build"], repository, true);
const filters = releaseNames.flatMap(name => ["--filter", name]);
const packed = JSON.parse(runPnpm([...filters, "pack", "--pack-destination", packs, "--json"]));
assert.deepEqual(packed.map(entry => entry.name).sort(), [...releaseNames].sort());
const overrides = {};
const inspections = [];
for (const entry of packed) {
  const source = manifests.get(entry.name).manifest;
  const tarball = join(packs, `${entry.name.slice(1).replace("/", "-")}-${source.version}.tgz`);
  const unpacked = join(output, entry.name.split("/")[1]);
  await mkdir(unpacked);
  await x({ file: tarball, cwd: unpacked, strict: true });
  const manifest = JSON.parse(await readFile(join(unpacked, "package", "package.json"), "utf8"));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, source.version);
  assert.notEqual(manifest.private, true);
  const paths = new Set(entry.files.map(file => file.path));
  assert.ok([...paths].some(path => /^licen[cs]e(?:\.|$)/iu.test(path)), `${entry.name}: missing license`);
  assert.ok([...paths].some(path => /^readme(?:\.|$)/iu.test(path)), `${entry.name}: missing README`);
  assert.ok(![...paths].some(path => path.endsWith(".tsbuildinfo") || path.startsWith("src/") || path.startsWith("test/")), `${entry.name}: unexpected packed sources`);
  const specifiers = [];
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const targets = typeof target === "string" ? [target] : Object.values(target);
    for (const file of targets) {
      assert.equal(typeof file, "string", `${entry.name}: review nested export conditions`);
      assert.ok(paths.has(file.replace(/^\.\//u, "")), `${entry.name}: missing export ${file}`);
    }
    const runtime = typeof target === "string" ? target : target.import;
    if (runtime?.endsWith(".js") || runtime?.endsWith(".mjs")) {
      specifiers.push({ name: entry.name + (subpath === "." ? "" : subpath.slice(1)), executable: subpath.startsWith("./examples/") });
    }
  }
  for (const [field, dependencies] of Object.entries(manifest)) {
    if (!["dependencies", "optionalDependencies", "peerDependencies"].includes(field)) continue;
    for (const [name, range] of Object.entries(dependencies)) {
      assert.ok(!name.startsWith("@may/") && !range.startsWith("workspace:"), `${entry.name}: unpublished dependency ${name}`);
      assert.ok(semver.validRange(range), `${entry.name}: non-registry dependency ${name}`);
      if (releaseNames.includes(name)) assert.ok(semver.satisfies(manifests.get(name).manifest.version, range), `${entry.name}: incompatible packed dependency ${name}`);
    }
  }
  overrides[entry.name] = `file:${tarball.replaceAll("\\", "/")}`;
  inspections.push({ name: entry.name, version: manifest.version, specifiers, declarations: [...paths].filter(path => path.endsWith(".d.ts")) });
}
await writeFile(join(consumer, "package.json"), JSON.stringify({
  name: "may-release-consumer", private: true, type: "module", dependencies: overrides,
  devDependencies: { "@types/node": "^22.0.0" },
}, null, 2));
runPnpm(["config", "set", "overrides", JSON.stringify(overrides), "--json", "--location", "project"], consumer);
runPnpm(["install", "--prefer-offline", "--ignore-scripts"], consumer, true);
await writeFile(join(consumer, "packed-inspections.json"), JSON.stringify(inspections, null, 2));
await copyFile(new URL("./release-consumer.mjs", import.meta.url), join(consumer, "verify.mjs"));
execFileSync(process.execPath, [join(consumer, "verify.mjs")], { cwd: consumer, stdio: "inherit", windowsHide: true });
await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"], lib: ["ES2022", "DOM", "DOM.Iterable"] },
  files: await Promise.all(inspections.flatMap(entry => entry.declarations.map(path => realpath(join(consumer, "node_modules", entry.name, path))))),
}, null, 2));
const compiler = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
execFileSync(process.execPath, [compiler, "-p", join(consumer, "tsconfig.json")], { cwd: consumer, stdio: "inherit", windowsHide: true });
const help = runPnpm(["exec", "maybecode", "--help"], consumer);
assert.match(help, /Usage:\s+maybecode/u);
console.log(`Verified ${inspections.length} packed packages, public imports, declarations and MaybeCode CLI`);
console.log(`External consumer: ${consumer}`);
