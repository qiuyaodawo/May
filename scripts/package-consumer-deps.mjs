import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

const WORKSPACE_GROUPS = ["packages", "packages/tools", "packages/ui", "apps"];

/**
 * Discover every workspace package manifest (`name -> { directory, relativeDirectory, manifest }`).
 */
export async function discoverWorkspacePackages(repository) {
  const packages = new Map();
  for (const group of WORKSPACE_GROUPS) {
    const groupPath = join(repository, group);
    let entries;
    try {
      entries = await readdir(groupPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(groupPath, entry.name);
      const manifestPath = join(directory, "package.json");
      let raw;
      try {
        raw = await readFile(manifestPath, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
        throw error;
      }
      const manifest = JSON.parse(raw);
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        packages.set(manifest.name, {
          name: manifest.name,
          directory,
          relativeDirectory: `${group}/${entry.name}`,
          manifest,
        });
      }
    }
  }
  return packages;
}

/**
 * Compute the transitive publishable workspace runtime dependency closure (dependencies,
 * optionalDependencies, peerDependencies) in topological order for `targetNames`.
 */
export function resolvePublishableRuntimeClosure(packages, targetNames) {
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(name) {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Circular publishable workspace dependency involving ${name}`);
    const entry = packages.get(name);
    if (!entry || entry.manifest.private) {
      throw new Error(`Runtime dependency is not a publishable workspace package: ${name}`);
    }
    visiting.add(name);
    const runtimeDeps = Object.keys({
      ...entry.manifest.dependencies,
      ...entry.manifest.optionalDependencies,
      ...entry.manifest.peerDependencies,
    });
    for (const dep of runtimeDeps) {
      if (packages.has(dep) || dep.startsWith("@sortedyuan/")) {
        visit(dep);
      }
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(name);
  }

  for (const target of targetNames) visit(target);
  return ordered;
}

/**
 * Resolve `devDependencies` required to run copied repository tests inside an external consumer.
 * Private workspace packages resolve via `link:`, third-party packages use their declared range,
 * and public workspace packages outside `packedRuntimeNames` fail closed.
 */
export function resolveConsumerTestDependencies(packages, packedRuntimeNames, testPaths, repository, consumer) {
  const packed = new Set(packedRuntimeNames);
  const testDependencies = new Map();
  for (const testPath of testPaths) {
    const normalizedPath = testPath.replaceAll("\\", "/");
    const owner = [...packages.values()].find((entry) => normalizedPath.startsWith(`${entry.relativeDirectory}/`));
    if (!owner) throw new Error(`Test file is outside a workspace package: ${testPath}`);
    for (const [name, range] of Object.entries(owner.manifest.devDependencies ?? {})) {
      let specifier;
      if (range.startsWith("workspace:")) {
        if (packed.has(name)) continue;
        const target = packages.get(name);
        if (!target?.manifest.private) {
          throw new Error(`Test dependency ${name} of ${owner.name} is a public package outside the packed chain`);
        }
        specifier = `link:${relative(consumer, target.directory).replaceAll("\\", "/")}`;
      } else {
        specifier = `${name}@${range}`;
      }
      const existing = testDependencies.get(name);
      if (existing !== undefined && existing !== specifier) {
        throw new Error(`Test dependency ${name} is declared as both ${existing} and ${specifier}`);
      }
      testDependencies.set(name, specifier);
    }
  }
  return testDependencies;
}

export function tarballFilename(name, version) {
  return `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;
}

export async function packWorkspacePackages({ packages, names, packsDirectory, repository, pnpm, consumer }) {
  const tarballs = [];
  const overrides = {};
  for (const name of names) {
    const entry = packages.get(name);
    if (!entry) throw new Error(`Unknown workspace package: ${name}`);
    await runPnpm(pnpm, ["--filter", name, "pack", "--pack-destination", packsDirectory], repository);
    const tarballPath = join(packsDirectory, tarballFilename(name, entry.manifest.version));
    tarballs.push(tarballPath);
    const refPath = consumer ? relative(consumer, tarballPath) : tarballPath;
    overrides[name] = `file:${refPath.replaceAll("\\", "/")}`;
  }
  const actualFiles = new Set(await readdir(packsDirectory));
  for (const tarball of tarballs) {
    if (!actualFiles.has(basename(tarball))) {
      throw new Error(`Packed runtime dependency is missing: ${basename(tarball)}`);
    }
  }
  return { tarballs, overrides };
}

export function runPnpm(pnpm, args, cwd, env = process.env) {
  return /\.[cm]?js$/iu.test(pnpm)
    ? runCommand(process.execPath, [pnpm, ...args], cwd, env)
    : runCommand(pnpm, args, cwd, env);
}

export async function runCommand(executable, args, cwd, env = process.env) {
  await new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? accept() : reject(new Error(`Package check command exited with ${code}`)),
    );
  });
}
