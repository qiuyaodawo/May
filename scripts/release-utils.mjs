import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";

export const repository = dirname(dirname(fileURLToPath(import.meta.url)));
export const releaseNames = JSON.parse(await readFile(new URL("./release-packages.json", import.meta.url), "utf8"));

export function runPnpm(args, cwd = repository, inherit = false) {
  const executable = process.env.npm_execpath;
  assert.ok(executable, "Run release checks through pnpm");
  const nodeScript = /\.[cm]?js$/iu.test(executable);
  return execFileSync(nodeScript ? process.execPath : executable, nodeScript ? [executable, ...args] : args, {
    cwd, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
    stdio: inherit ? "inherit" : "pipe",
  });
}

export async function checkRelease() {
  assert.equal(releaseNames.length, 14, "Review the explicit release scope before changing its size");
  assert.equal(new Set(releaseNames).size, releaseNames.length, "Duplicate release package");
  const root = JSON.parse(await readFile(join(repository, "package.json"), "utf8"));
  assert.equal(`pnpm@${runPnpm(["--version"]).trim()}`, root.packageManager);
  const projects = JSON.parse(runPnpm(["list", "--recursive", "--depth", "-1", "--json"]));
  const manifests = new Map();
  for (const project of projects) {
    const manifest = JSON.parse(await readFile(join(project.path, "package.json"), "utf8"));
    manifests.set(manifest.name, { directory: project.path, manifest });
  }
  for (const name of releaseNames) assert.ok(manifests.has(name), `Missing release package: ${name}`);
  for (const [name, { manifest }] of manifests) {
    const selected = releaseNames.includes(name);
    assert.equal(manifest.private !== true, selected, `Public package list differs for ${name}`);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        assert.ok(!dependency.startsWith("@may/"), `${name}: old dependency ${dependency}`);
        if (range.startsWith("workspace:")) assert.ok(manifests.has(dependency), `${name}: missing workspace dependency ${dependency}`);
        if (!selected || field === "devDependencies") continue;
        if (manifests.has(dependency)) {
          assert.ok(releaseNames.includes(dependency), `${name}: private runtime dependency ${dependency}`);
          assert.ok(range.startsWith("workspace:") || semver.satisfies(manifests.get(dependency).manifest.version, range), `${name}: incompatible ${dependency}`);
        } else {
          assert.ok(semver.validRange(range), `${name}: runtime dependency must use a registry version range: ${dependency}`);
        }
      }
    }
    if (!selected) continue;
    assert.ok(name.startsWith("@sortedyuan/"), `Unexpected release scope: ${name}`);
    assert.ok(semver.valid(manifest.version), `${name}: invalid version`);
    assert.equal(manifest.license, "MIT", `${name}: verify license metadata`);
    assert.ok(manifest.exports, `${name}: missing public exports`);
    assert.ok(manifest.files?.length, `${name}: missing packed file list`);
    assert.ok(semver.validRange(manifest.engines?.node), `${name}: missing Node.js requirement`);
  }
  return manifests;
}
