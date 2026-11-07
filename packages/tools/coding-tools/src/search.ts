import { spawn } from "node:child_process";
import { rgPath } from "@vscode/ripgrep";
import type { CodingExecutionEnvironment } from "./execution.js";
import { CodingToolError } from "./errors.js";
import { requirePositiveIntegerOption } from "./input.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

/** @experimental */
export interface SearchToolOptions {
  readonly cwd: string;
  readonly maxResults?: number;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  readonly execution?: CodingExecutionEnvironment;
}

/** @experimental */
export function searchLimits(options: SearchToolOptions) {
  return {
    maxResults: requirePositiveIntegerOption(options.maxResults, 1000, "maxResults"),
    maxOutputBytes: requirePositiveIntegerOption(options.maxOutputBytes, 1024 * 1024, "maxOutputBytes"),
    timeoutMs: requirePositiveIntegerOption(options.timeoutMs, 30_000, "timeoutMs"),
  };
}

/** @experimental */
export async function runSearch(
  options: SearchToolOptions,
  args: readonly string[],
  path: string,
  signal: AbortSignal,
): Promise<{ readonly data: Buffer; readonly truncated: boolean }> {
  const limits = searchLimits(options);
  signal.throwIfAborted();
  const target = await resolveExistingWorkspacePath(options.cwd, path);
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const command = options.execution?.isolation.mode === "container" ? "rg" : rgPath;
  const processArgs = ["--no-config", "--no-require-git", ...args, "--", target.relative];
  const child =
    options.execution === undefined
      ? spawn(command, processArgs, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
      : options.execution.spawn(command, processArgs, { cwd: options.cwd, signal: combined });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let length = 0;
  let errorLength = 0;
  let truncated = false;
  let timedOut = false;
  const stop = () => {
    child.kill("SIGKILL");
  };
  const onAbort = () => {
    if (options.execution === undefined) stop();
  };
  combined.addEventListener("abort", onAbort, { once: true });
  if (combined.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, limits.timeoutMs);
  const finished = new Promise<{ code: number | null; error?: Error }>((resolve) => {
    let error: Error | undefined;
    child.on("error", (value: Error) => {
      error = value;
    });
    child.once("close", (code: number | null) => resolve(error === undefined ? { code } : { code, error }));
  });
  if (child.stdout === null || child.stderr === null) {
    stop();
    await finished;
    throw new CodingToolError("CODING_TOOL_SEARCH_PROCESS", "Search requires piped output");
  }
  child.stdout.on("data", (chunk: Buffer) => {
    const remaining = limits.maxOutputBytes - length;
    if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
    length += chunk.length;
    if (length > limits.maxOutputBytes) {
      truncated = true;
      controller.abort();
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (errorLength < limits.maxOutputBytes) errors.push(chunk.subarray(0, limits.maxOutputBytes - errorLength));
    errorLength += chunk.length;
  });
  const result = await finished;
  clearTimeout(timer);
  combined.removeEventListener("abort", onAbort);
  signal.throwIfAborted();
  if (timedOut) throw new CodingToolError("CODING_TOOL_SEARCH_TIMEOUT", "Search exceeded timeoutMs");
  if (result.error !== undefined) throw result.error;
  if (!truncated && result.code !== 0 && result.code !== 1) {
    throw new CodingToolError(
      "CODING_TOOL_SEARCH_PROCESS",
      `rg exited with ${result.code}: ${Buffer.concat(errors).toString("utf8")}`,
    );
  }
  return { data: Buffer.concat(chunks), truncated };
}
