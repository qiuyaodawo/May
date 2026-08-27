import { spawn, type ChildProcess } from "node:child_process";
import type { Tool } from "@may/core";
import { CodingToolError } from "./errors.js";
import {
  optionalPositiveInteger,
  requireObject,
  requirePositiveIntegerOption,
  requireString,
} from "./input.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

export const DEFAULT_BASH_TIMEOUT_MS = 120_000;
export const DEFAULT_BASH_MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_BASH_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface BashToolOptions {
  readonly cwd: string;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly shell?: boolean | string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}

export interface BashToolInput {
  readonly command: string;
  readonly timeoutMs?: number;
}

export interface BashToolOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export function createBashTool(options: BashToolOptions): Tool<
  BashToolInput,
  BashToolOutput
> {
  const defaultTimeoutMs = requirePositiveIntegerOption(
    options.defaultTimeoutMs,
    DEFAULT_BASH_TIMEOUT_MS,
    "defaultTimeoutMs",
  );
  const maxTimeoutMs = requirePositiveIntegerOption(
    options.maxTimeoutMs,
    DEFAULT_BASH_MAX_TIMEOUT_MS,
    "maxTimeoutMs",
  );
  const maxOutputBytes = requirePositiveIntegerOption(
    options.maxOutputBytes,
    DEFAULT_BASH_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new RangeError("defaultTimeoutMs must not exceed maxTimeoutMs");
  }

  return {
    name: "bash",
    description: "Execute a shell command in the workspace. This is not a sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeoutMs: { type: "integer", minimum: 1, maximum: maxTimeoutMs },
      },
      required: ["command"],
      additionalProperties: false,
    },
    parse(input) {
      const value = requireObject(input, "bash");
      const command = requireString(value.command, "bash", "command");
      const timeoutMs = optionalPositiveInteger(
        value.timeoutMs,
        "bash",
        "timeoutMs",
      );
      if (timeoutMs !== undefined && timeoutMs > maxTimeoutMs) {
        throw new CodingToolError(
          "CODING_TOOL_INVALID_INPUT",
          `bash: timeoutMs must not exceed ${maxTimeoutMs}`,
        );
      }
      return {
        command,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    },
    async execute(input, context) {
      if (context.signal.aborted) {
        throw new CodingToolError("CODING_TOOL_CANCELLED", "bash: command was cancelled");
      }
      const workspace = await resolveExistingWorkspacePath(options.cwd, ".");
      return executeCommand(
        input.command,
        input.timeoutMs ?? defaultTimeoutMs,
        maxOutputBytes,
        workspace.absolute,
        options,
        context.signal,
      );
    },
  };
}

function executeCommand(
  command: string,
  timeoutMs: number,
  maxOutputBytes: number,
  cwd: string,
  options: BashToolOptions,
  abortSignal: AbortSignal,
): Promise<BashToolOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: options.shell ?? true,
      env: options.env === undefined
        ? process.env
        : { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createOutputCollector(maxOutputBytes);
    const stderr = createOutputCollector(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    child.stdout.on("data", stdout.append);
    child.stderr.on("data", stderr.append);

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    const abort = () => {
      cancelled = true;
      terminateProcessTree(child);
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();

    const cleanup = () => {
      clearTimeout(timeout);
      abortSignal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    child.once("error", (error) => {
      fail(new CodingToolError(
        "CODING_TOOL_COMMAND_FAILED",
        `bash: unable to start command: ${error.message}`,
        { cause: error },
      ));
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelled) {
        reject(new CodingToolError(
          "CODING_TOOL_CANCELLED",
          "bash: command was cancelled",
        ));
        return;
      }
      if (timedOut) {
        reject(new CodingToolError(
          "CODING_TOOL_COMMAND_TIMEOUT",
          `bash: command exceeded ${timeoutMs}ms`,
        ));
        return;
      }
      resolve({
        stdout: stdout.text(),
        stderr: stderr.text(),
        exitCode,
        signal,
        stdoutTruncated: stdout.truncated(),
        stderrTruncated: stderr.truncated(),
      });
    });
  });
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", () => child.kill("SIGKILL"));
    return;
  }

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

interface OutputCollector {
  readonly append: (chunk: Buffer) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
}

function createOutputCollector(maxBytes: number): OutputCollector {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  return {
    append(chunk) {
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.byteLength;
      }
      if (chunk.byteLength > remaining) wasTruncated = true;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
    truncated: () => wasTruncated,
  };
}
