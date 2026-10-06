import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EnvironmentPrepareContext, EvalEnvironmentAdapter, JsonValue, EvaluationTarget } from "./types.js";

export interface FileManifestEntry { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface LocalDirectoryEnvironmentOptions {
  readonly id?: string;
  readonly version?: string;
  readonly sourceDirectory: string;
  readonly rootDirectory: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly excludeNames?: readonly string[];
}

export function createLocalDirectoryEnvironment(options: LocalDirectoryEnvironmentOptions): EvalEnvironmentAdapter {
  const maxFiles = positive(options.maxFiles ?? 10_000);
  const maxBytes = positive(options.maxBytes ?? 67_108_864);
  const excluded = new Set([".git", "node_modules", ".env", ".eval-results", ...(options.excludeNames ?? [])]);
  for (const name of excluded) if (!name || /[\\/]/u.test(name) || name === "." || name === "..") throw new TypeError("Excluded names must be basenames");
  const capabilities = Object.freeze({ independentResources: true, filesystemIsolation: false, processIsolation: false,
    networkIsolation: false, credentialIsolation: false, protectedEvaluationResources: false });
  async function paths(context: EnvironmentPrepareContext) {
    const source = await realpath(options.sourceDirectory);
    const intended = await potentialPath(resolve(options.rootDirectory));
    if (within(source, intended) || within(intended, source)) throw new Error("Environment source and output must not overlap");
    await mkdir(options.rootDirectory, { recursive: true });
    const root = await realpath(options.rootDirectory);
    if (within(source, root) || within(root, source)) throw new Error("Environment source and output must not overlap");
    const identity = digest(`${context.trial.experimentId}\0${context.trial.id}`);
    const trialRoot = join(root, identity);
    return { source, root, trialRoot, workspace: join(trialRoot, "workspace"), baseline: join(trialRoot, "baseline"), frozen: join(trialRoot, "frozen") };
  }
  return {
    id: options.id ?? "local-directory", version: options.version ?? "1", capabilities,
    validate(values) { if (Object.keys(values).length) throw new TypeError("Local directory configuration belongs to the registered adapter"); },
    async prepare(context) {
      const path = await paths(context);
      context.signal.throwIfAborted();
      await mkdir(path.trialRoot);
      const baseline = await snapshot(path.source, path.baseline, context.signal, excluded, maxFiles, maxBytes);
      await snapshot(path.baseline, path.workspace, context.signal, new Set(), maxFiles, maxBytes);
      let disposed = false;
      let frozen: EvaluationTarget | undefined;
      return {
        id: path.trialRoot, capabilities, executionTarget: { workspacePath: path.workspace },
        async freeze(signal) {
          signal.throwIfAborted();
          if (disposed) throw new Error("Cannot freeze a disposed environment");
          if (frozen) return frozen;
          const manifest = await snapshot(path.workspace, path.frozen, signal, new Set(), maxFiles, maxBytes);
          frozen = { workspacePath: path.frozen, baselinePath: path.baseline, data: {
            baselineManifest: baseline as unknown as JsonValue, manifest: manifest as unknown as JsonValue,
            baselineDigest: digest(JSON.stringify(baseline)), snapshotDigest: digest(JSON.stringify(manifest)),
          } };
          return frozen;
        },
        async dispose(signal) {
          signal.throwIfAborted();
          await removeWorkspace(path.root, path.trialRoot, path.workspace);
          disposed = true;
        },
      };
    },
    async recover(context) {
      const path = await paths(context);
      context.signal.throwIfAborted();
      await removeWorkspace(path.root, path.trialRoot, path.workspace);
    },
  };
}

export async function readFileManifest(directory: string, signal: AbortSignal, maxFiles = 10_000, maxBytes = 67_108_864): Promise<readonly FileManifestEntry[]> {
  return scan(directory, signal, new Set(), positive(maxFiles), positive(maxBytes));
}

async function snapshot(source: string, destination: string, signal: AbortSignal, excluded: ReadonlySet<string>, maxFiles: number, maxBytes: number) {
  const entries = await scan(source, signal, excluded, maxFiles, maxBytes);
  await mkdir(destination);
  for (const entry of entries) {
    signal.throwIfAborted();
    const from = join(source, entry.path);
    await assertRegular(from);
    const to = join(destination, entry.path);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
    const copied = await readFile(to);
    if (copied.length !== entry.bytes || digest(copied) !== entry.sha256) throw new Error("Source changed while preparing environment");
  }
  return entries;
}

async function scan(directory: string, signal: AbortSignal, excluded: ReadonlySet<string>, maxFiles: number, maxBytes: number) {
  const root = await realpath(directory);
  const entries: FileManifestEntry[] = [];
  let bytes = 0;
  async function walk(path: string): Promise<void> {
    signal.throwIfAborted();
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Environment snapshots reject symbolic links");
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        if (!excluded.has(name) && !(excluded.has(".env") && name.startsWith(".env."))) await walk(join(path, name));
      }
      return;
    }
    if (!stat.isFile()) throw new Error("Environment snapshots require regular files");
    if (entries.length >= maxFiles || bytes + stat.size > maxBytes) throw new RangeError("Environment snapshot limit exceeded");
    const content = await readFile(path);
    bytes += content.length;
    if (bytes > maxBytes) throw new RangeError("Environment snapshot byte limit exceeded");
    entries.push({ path: relative(root, path).split(sep).join("/"), bytes: content.length, sha256: digest(content) });
  }
  await walk(root);
  return entries;
}

async function assertRegular(path: string) { if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) throw new Error("Snapshot source must be a regular file"); }
async function removeWorkspace(root: string, trialRoot: string, workspace: string) {
  if (dirname(trialRoot) !== root || dirname(workspace) !== trialRoot || !within(root, workspace)) throw new Error("Invalid environment cleanup path");
  let exists: boolean;
  try { await lstat(workspace); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; exists = false; }
  if (!exists) return;
  if (await realpath(trialRoot) !== trialRoot || await realpath(workspace) !== workspace) throw new Error("Environment cleanup path changed");
  await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
async function potentialPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await potentialPath(parent), relative(parent, path));
  }
}
export function within(root: string, path: string) { const name = relative(root, path); return name === "" || !isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`); }
function digest(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function positive(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Snapshot limits must be positive integers"); return value; }
