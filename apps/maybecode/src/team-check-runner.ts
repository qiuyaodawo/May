import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { openCodingExecutionEnvironment, type CodingExecutionEnvironment } from "@sortedyuan/coding-tools";
import { safeRelative, type TeamCheckSpec } from "./team-check-spec.js";
import type { TeamCheckResult } from "./team-verification.js";

/** All directory/file names and file bytes count; no ignored changes can retain a green check. */
export async function workspaceFingerprint(directory: string): Promise<string> {
  const root = await realpath(directory);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error("Workspace root must not be a symbolic link");
  const entries: unknown[] = [];
  let bytes = 0;
  let files = 0;
  async function visit(path: string): Promise<void> {
    const names = (await readdir(path)).sort();
    for (const name of names) {
      const child = join(path, name);
      const stat = await lstat(child);
      const nameInRoot = relative(root, child).split(sep).join("/");
      if (++files > 10000 || stat.isSymbolicLink())
        throw new Error("Workspace exceeds 10000 entries or contains a symbolic link");
      if (stat.isDirectory()) {
        entries.push([nameInRoot, "directory"]);
        await visit(child);
      } else if (stat.isFile()) {
        if ((bytes += stat.size) > 67108864) throw new Error("Workspace exceeds 64 MiB");
        const content = await readWorkspaceFile(root, nameInRoot);
        entries.push([nameInRoot, "file", content.length, hash(content)]);
      } else throw new Error("Workspace contains unsupported file type");
    }
  }
  await visit(root);
  return hash(JSON.stringify(entries));
}

export async function readWorkspaceFile(directory: string, path: string): Promise<Buffer> {
  safeRelative(path);
  const root = await realpath(directory);
  let target = root;
  for (const part of path.replace(/\\/gu, "/").split("/")) {
    target = join(target, part);
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Evidence/check path must not contain symbolic links");
  }
  const canonical = await realpath(target);
  const rel = relative(root, canonical);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))
    throw new Error("Evidence/check path escapes workspace");
  const before = await lstat(target);
  if (!before.isFile() || before.size > 67108864) throw new Error("Evidence/check file is invalid or exceeds 64 MiB");
  const file = await open(target, constants.O_RDONLY | noFollow());
  try {
    const current = await file.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size)
      throw new Error("File changed while opening");
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const chunk = await file.read(buffer, length, buffer.length - length, length);
      if (!chunk.bytesRead) break;
      length += chunk.bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs)
      throw new Error("File changed while reading");
    return buffer.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function runCommand(
  spec: Extract<TeamCheckSpec, { type: "command" }>,
  workspace: string,
  signal?: AbortSignal,
  executionFor?: (workspace: string) => Promise<CodingExecutionEnvironment>,
): Promise<Pick<TeamCheckResult, "status" | "detail" | "exitCode" | "output">> {
  const environment = executionFor
    ? await executionFor(workspace)
    : await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
  try {
    return await runEnvironmentCommand(spec, workspace, environment, signal);
  } finally {
    if (!executionFor) await environment.close();
  }
}

async function runEnvironmentCommand(
  spec: Extract<TeamCheckSpec, { type: "command" }>,
  workspace: string,
  environment: CodingExecutionEnvironment,
  signal?: AbortSignal,
): Promise<Pick<TeamCheckResult, "status" | "detail" | "exitCode" | "output">> {
  signal?.throwIfAborted();
  if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(spec.command))
    return {
      status: "failed",
      detail:
        "Command checks execute native programs directly. Use node.exe with the package manager JavaScript entry point, not .cmd/.bat.",
    };
  const cwd = await realpath(workspace);
  const env: Record<string, string> = {};
  // No inherited API keys, proxy tokens, NODE_OPTIONS, package hooks, or user home config.
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
  ])
    if (environment.isolation.mode === "host" && process.env[key] !== undefined) env[key] = process.env[key];
  env.CI = "1";
  return new Promise((resolveResult, rejectResult) => {
    const cancellation = new AbortController();
    let output = Buffer.alloc(0);
    let reason: string | undefined;
    let settled = false;
    const child = environment.spawn(spec.command, spec.args, {
      cwd,
      env,
      signal: cancellation.signal,
    });
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      rejectResult(new Error("Execution environment must provide command output pipes"));
      return;
    }
    const finish = (status: "passed" | "failed" | "unknown", exitCode?: number, detail?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolveResult({
        status,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(detail ? { detail } : {}),
        output: boundedOutput(output, spec.maxOutputBytes ?? 65536),
      });
    };
    const stop = (detail: string) => {
      if (reason) return;
      reason = detail;
      cancellation.abort();
    };
    const abort = () => stop("Check interrupted");
    const timer = setTimeout(() => stop("Check timed out"), spec.timeoutMs ?? 30000);
    const collect = (chunk: Buffer) => {
      const limit = spec.maxOutputBytes ?? 65536;
      if (output.length + chunk.length > limit) {
        output = Buffer.concat([output, chunk.subarray(0, limit - output.length)]);
        stop("Check output limit exceeded");
      } else output = Buffer.concat([output, chunk]);
    };
    stdout.on("data", collect);
    stderr.on("data", collect);
    child.on("error", (error) => finish(child.pid === undefined ? "failed" : "unknown", undefined, message(error)));
    child.on("close", (code, terminationSignal) => {
      if (reason || terminationSignal || code === null)
        finish("unknown", undefined, reason ?? `Check ended by ${terminationSignal ?? "unknown termination"}`);
      else
        finish(
          code === 0 ? "passed" : "failed",
          code,
          code === 0 ? "Configured command exited successfully" : "Configured command exited unsuccessfully",
        );
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function noFollow(): number {
  return process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
}
export function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
export function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2048);
}
function boundedOutput(bytes: Buffer, limit: number): string {
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text) <= limit) return text;
  // Replacement characters for invalid UTF-8 must not expand the persisted output past its cap.
  let count = 0;
  const characters: string[] = [];
  for (const character of text) {
    count += Buffer.byteLength(character);
    if (count > limit) break;
    characters.push(character);
  }
  return characters.join("");
}
