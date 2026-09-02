import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repository = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const requestedSmokeParent = resolveSmokeParent(process.argv.slice(2));
await mkdir(requestedSmokeParent, { recursive: true });
const smokeParent = await realpath(requestedSmokeParent);
const directory = join(smokeParent, "may-maybecode-package-smoke");
const packsDirectory = join(directory, "packs");
const consumerDirectory = join(directory, "consumer");
const workspaceDirectory = join(consumerDirectory, "workspace");
const homeDirectory = join(consumerDirectory, "home");
const pnpm = resolvePnpmCommand();
const repositoryStore = (await runPnpm(["store", "path"], {
  cwd: repository,
})).stdout.trim();

await resetSmokeDirectory(directory);
await mkdir(packsDirectory, { recursive: true });

// TypeScript incremental builds do not remove outputs for deleted source files.
// Pack from a fresh application dist so retired implementation modules cannot
// leak into the tarball after a refactor.
await rm(join(repository, "apps", "maybecode", "dist"), {
  recursive: true,
  force: true,
});
await runPnpm(["run", "build"], { cwd: repository, inherit: true });
const packedOutput = await runPnpm([
  "--filter",
  "@may/maybecode...",
  "pack",
  "--pack-destination",
  packsDirectory,
  "--json",
], { cwd: repository });
const packed = parsePackedOutput(packedOutput.stdout);
assert.equal(
  packed.some((entry) => entry.files.some((file) => file.path.endsWith(".tsbuildinfo"))),
  false,
  "TypeScript build metadata leaked into a package",
);
const application = packed.find((entry) => entry.name === "@may/maybecode");
assert.ok(application, "@may/maybecode was not packed");
const applicationPaths = application.files.map((file) => file.path);
assert.ok(applicationPaths.includes("dist/bin.js"), "packed bin is missing");
assert.ok(applicationPaths.includes("dist/index.js"), "packed entry point is missing");
const retiredModules = [
  "dist/ui/tool-renderers",
  "dist/ui/transcript-store",
  "dist/ui/transcript-view",
];
assert.equal(
  applicationPaths.some((path) => retiredModules.some((module) =>
    path === module || path.startsWith(`${module}.`)
  )),
  false,
  "retired MaybeCode TUI implementations leaked into the package",
);
assert.equal(
  applicationPaths.some((path) => path.startsWith("src/") || path.startsWith("test/")),
  false,
  "source or test files leaked into the MaybeCode package",
);

const packages = await reachableWorkspacePackages("@may/maybecode");
assert.equal(packages.length, packed.length, "the packed dependency graph is incomplete");
assert.equal(
  packages.filter((pkg) => pkg.private === true).map((pkg) => pkg.name).join(","),
  "@may/maybecode",
  "only the locally packed MaybeCode application may be private",
);
await mkdir(workspaceDirectory, { recursive: true });
await mkdir(homeDirectory, { recursive: true });

const localTarballs = Object.fromEntries(packages.map((pkg) => [
  pkg.name,
  toFileSpecifier(consumerDirectory, join(
    packsDirectory,
    tarballName(pkg.name, pkg.version),
  )),
]));
await writeFile(join(consumerDirectory, "package.json"), JSON.stringify({
  name: "maybecode-package-smoke",
  private: true,
  type: "module",
  dependencies: {
    "@may/maybecode": localTarballs["@may/maybecode"],
  },
}, null, 2) + "\n", "utf8");
await writeFile(
  join(consumerDirectory, "pnpm-workspace.yaml"),
  `packages:\n  - "."\noverrides:\n${Object.entries(localTarballs)
    .map(([name, specifier]) => `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`)
    .join("\n")}\n`,
  "utf8",
);
await writeFile(join(consumerDirectory, "config.json"), JSON.stringify({
  defaultModel: "deepseek",
  providers: {
    deepseek: {
      adapter: "deepseek-chat",
      apiKey: "package-smoke-key",
    },
  },
  models: {
    deepseek: {
      provider: "deepseek",
      model: "deepseek-chat",
    },
  },
}, null, 2) + "\n", "utf8");

await runPnpm([
  "install",
  "--offline",
  "--ignore-scripts",
  "--store-dir",
  repositoryStore,
], {
  cwd: consumerDirectory,
  inherit: true,
});
const bin = join(
  consumerDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "maybecode.CMD" : "maybecode",
);
await access(bin);

const help = await runPnpm(["exec", "maybecode", "--help"], {
  cwd: consumerDirectory,
});
assert.match(help.stdout, /Usage:\s+maybecode/u);

const launched = await runPnpm([
  "exec",
  "maybecode",
  "--ui",
  "classic",
  "--config",
  join(consumerDirectory, "config.json"),
  workspaceDirectory,
], {
  cwd: consumerDirectory,
  env: {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory,
  },
  input: "/quit\n",
  inputAfter: /Type \/help/u,
});
assert.match(launched.stdout, /MaybeCode/u);
assert.match(launched.stdout, new RegExp(`Workspace: ${escapeRegExp(
  await realpath(workspaceDirectory),
)}`, "u"));
assert.doesNotMatch(launched.stdout + launched.stderr, /Error:/u);

process.stdout.write(
  `MaybeCode package smoke test passed outside the repository:\n${consumerDirectory}\n`,
);

function resolveSmokeParent(args) {
  let value;
  for (let index = 0; index < args.length; index++) {
    if (index === 0 && args[index] === "--") continue;
    if (args[index] !== "--directory") {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
    if (value !== undefined) throw new Error("--directory may only be specified once");
    value = args[++index];
    if (value === undefined || value.trim() === "") {
      throw new Error("--directory requires a value");
    }
  }
  return resolve(value ?? tmpdir());
}

async function resetSmokeDirectory(target) {
  const parent = dirname(target);
  if (
    basename(target) !== "may-maybecode-package-smoke" ||
    target === parent ||
    target === repository ||
    isInside(target, repository) ||
    isInside(repository, target)
  ) {
    throw new Error(`Refusing to clear unsafe smoke directory: ${target}`);
  }
  await mkdir(parent, { recursive: true });
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
}

function isInside(candidate, parent) {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) &&
    !isAbsolute(path);
}

async function reachableWorkspacePackages(rootName) {
  const manifests = await discoverWorkspacePackages();
  const selected = new Map();
  const visit = (name) => {
    if (selected.has(name)) return;
    const pkg = manifests.get(name);
    if (pkg === undefined) throw new Error(`Missing workspace package: ${name}`);
    selected.set(name, pkg);
    for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
      if (typeof version === "string" && version.startsWith("workspace:")) {
        visit(dependency);
      }
    }
  };
  visit(rootName);
  return [...selected.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverWorkspacePackages() {
  const roots = [join(repository, "packages"), join(repository, "apps")];
  const manifests = new Map();
  for (const root of roots) await scan(root, manifests);
  return manifests;
}

async function scan(directory, manifests) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const child = join(directory, entry.name);
    const manifestPath = join(child, "package.json");
    try {
      const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof pkg.name === "string" && typeof pkg.version === "string") {
        manifests.set(pkg.name, pkg);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await scan(child, manifests);
  }
}

function parsePackedOutput(output) {
  const value = JSON.parse(output);
  if (!Array.isArray(value)) throw new Error("pnpm pack returned an invalid result");
  return value;
}

function tarballName(name, version) {
  return `${name.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
}

function toFileSpecifier(from, path) {
  return `file:${relative(from, path).replaceAll("\\", "/")}`;
}

function resolvePnpmCommand() {
  const executable = process.env.npm_execpath;
  if (executable === undefined || !basename(executable).toLowerCase().includes("pnpm")) {
    throw new Error("Run this smoke test through pnpm");
  }
  return executable;
}

function runPnpm(args, options = {}) {
  return run(process.execPath, [pnpm, ...args], options);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (options.inherit) {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolvePromise({ stdout: "", stderr: "" });
        else reject(commandError(command, args, code, signal, ""));
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let inputSent = false;
    const sendInput = () => {
      if (inputSent) return;
      inputSent = true;
      child.stdin.end(options.input ?? "");
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.inputAfter?.test(stdout) === true) sendInput();
    });
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(commandError(command, args, code, signal, stdout + stderr));
    });
    if (options.inputAfter === undefined) sendInput();
  });
}

function commandError(command, args, code, signal, output) {
  return new Error(
    `${command} ${args.join(" ")} failed ` +
      `(code ${String(code)}, signal ${String(signal)})${output === "" ? "" : `:\n${output}`}`,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
