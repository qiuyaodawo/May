import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { omitUndefined, type Tool, type ToolProgressUpdate } from "@sortedyuan/may/core";
import { CodingToolError } from "./errors.js";
import type { CodingExecutionEnvironment } from "./execution.js";
import { optionalPositiveInteger, requireObject, requirePositiveIntegerOption, requireString } from "./input.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

/** @experimental */
export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
/** @experimental */
export const DEFAULT_SHELL_MAX_TIMEOUT_MS = 600_000;
/** @experimental */
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 1024 * 1024;

/** @experimental */
export type ShellKind = "powershell" | "bash" | "custom";

/** @experimental */
export interface ShellProfile {
  readonly kind: ShellKind;
  readonly displayName: string;
  readonly executable: string;
  readonly args: (command: string) => readonly string[];
}

/** @experimental */
export interface ShellToolInfo {
  readonly kind: ShellKind;
  readonly displayName: string;
  readonly executable: string;
}

/** @experimental */
export interface ShellToolOptions {
  readonly cwd: string;
  readonly execution?: CodingExecutionEnvironment;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly profile?: ShellProfile;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly inheritEnv?: boolean;
  readonly envAllowlist?: readonly string[];
  readonly envDenylist?: readonly string[];
}

/** @experimental */
export interface ShellToolInput {
  readonly command: string;
  readonly timeoutMs?: number;
}

/** @experimental */
export interface ShellToolOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

const shellToolInfo = Symbol("may.coding-tools.shell-info");

/** @experimental */
export function createDefaultShellProfile(platform: NodeJS.Platform = process.platform): ShellProfile {
  return platform === "win32" ? createPowerShellProfile() : createBashShellProfile();
}

/** @experimental */
export function createPowerShellProfile(
  options: { readonly executable?: string; readonly displayName?: string } = {},
): ShellProfile {
  const executable = options.executable ?? defaultPowerShellExecutable();
  const displayName =
    options.displayName ?? (/(?:^|[\\/])pwsh(?:\.exe)?$/iu.test(executable) ? "PowerShell 7" : "Windows PowerShell");
  return {
    kind: "powershell",
    displayName,
    executable,
    args: (command) => [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      powerShellScript(command),
    ],
  };
}

/** @experimental */
export function createBashShellProfile(
  options: { readonly executable?: string; readonly displayName?: string } = {},
): ShellProfile {
  return {
    kind: "bash",
    displayName: options.displayName ?? "Bash",
    executable: options.executable ?? "bash",
    args: (command) => ["-c", command],
  };
}

/** @experimental */
export function createShellTool(options: ShellToolOptions): Tool<ShellToolInput, ShellToolOutput> {
  const defaultTimeoutMs = requirePositiveIntegerOption(
    options.defaultTimeoutMs,
    DEFAULT_SHELL_TIMEOUT_MS,
    "defaultTimeoutMs",
  );
  const maxTimeoutMs = requirePositiveIntegerOption(options.maxTimeoutMs, DEFAULT_SHELL_MAX_TIMEOUT_MS, "maxTimeoutMs");
  const maxOutputBytes = requirePositiveIntegerOption(
    options.maxOutputBytes,
    DEFAULT_SHELL_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new RangeError("defaultTimeoutMs must not exceed maxTimeoutMs");
  }
  const profile = validateShellProfile(
    options.profile ??
      (options.execution?.isolation.mode === "container" ? createBashShellProfile() : createDefaultShellProfile()),
  );
  const info: ShellToolInfo = {
    kind: profile.kind,
    displayName: profile.displayName,
    executable: profile.executable,
  };

  const tool: Tool<ShellToolInput, ShellToolOutput> = {
    name: "shell",
    description: "Execute a shell command in the workspace using the configured execution environment.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: `Command written for ${info.displayName}`,
        },
        timeoutMs: { type: "integer", minimum: 1, maximum: maxTimeoutMs },
      },
      required: ["command"],
      additionalProperties: false,
    },
    parse(input) {
      const value = requireObject(input, "shell");
      const command = requireString(value.command, "shell", "command");
      const timeoutMs = optionalPositiveInteger(value.timeoutMs, "shell", "timeoutMs");
      if (timeoutMs !== undefined && timeoutMs > maxTimeoutMs) {
        throw new CodingToolError("CODING_TOOL_INVALID_INPUT", `shell: timeoutMs must not exceed ${maxTimeoutMs}`);
      }
      return omitUndefined({ command, timeoutMs });
    },
    async execute(input, context) {
      if (context.signal.aborted) {
        throw new CodingToolError("CODING_TOOL_CANCELLED", "shell: command was cancelled");
      }
      const workspace = await resolveExistingWorkspacePath(options.cwd, ".");
      return executeCommand(
        input.command,
        input.timeoutMs ?? defaultTimeoutMs,
        maxOutputBytes,
        workspace.absolute,
        options,
        profile,
        context.signal,
        context.report,
      );
    },
  };
  Object.defineProperty(tool, shellToolInfo, {
    value: Object.freeze(info),
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return tool;
}

/** @experimental */
export function getShellToolInfo(tool: Tool): ShellToolInfo | undefined {
  const info = (tool as Tool & { readonly [shellToolInfo]?: ShellToolInfo })[shellToolInfo];
  return info === undefined ? undefined : { ...info };
}

/** @experimental */
export function shellRuntimeInstructions(info: ShellToolInfo): string {
  if (info.kind === "powershell") {
    return (
      "Use PowerShell syntax and cmdlets; do not assume POSIX utilities such " + "as ls, find, or head are installed."
    );
  }
  if (info.kind === "bash") {
    return "Use Bash syntax.";
  }
  return "Follow the configured shell's syntax.";
}

function executeCommand(
  command: string,
  timeoutMs: number,
  maxOutputBytes: number,
  cwd: string,
  options: ShellToolOptions,
  profile: ShellProfile,
  abortSignal: AbortSignal,
  report: (update: ToolProgressUpdate) => void,
): Promise<ShellToolOutput> {
  return new Promise((resolve, reject) => {
    const executionAbort = new AbortController();
    const child =
      options.execution === undefined
        ? spawn(profile.executable, [...profile.args(command)], {
            cwd,
            shell: false,
            env: shellEnvironment(options),
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : options.execution.spawn(profile.executable, profile.args(command), {
            cwd,
            signal: executionAbort.signal,
            env: shellEnvironment(options) as Record<string, string>,
          });
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    if (childStdout === null || childStderr === null) {
      reject(
        new CodingToolError("CODING_TOOL_COMMAND_FAILED", "Execution environment must provide stdout and stderr pipes"),
      );
      return;
    }
    const stdout = createOutputCollector(maxOutputBytes);
    const stderr = createOutputCollector(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (options.execution !== undefined) {
        executionAbort.abort();
        return;
      }
      terminateProcessTree(child);
      drainTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        childStdout.destroy();
        childStderr.destroy();
        child.unref();
        fail(
          new CodingToolError(
            cancelled ? "CODING_TOOL_CANCELLED" : "CODING_TOOL_COMMAND_TIMEOUT",
            "shell: command stopped; process-tree termination could not be confirmed",
          ),
        );
      }, 1000);
    };

    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => {
      stdout.append(chunk);
      report({ type: "output.delta", channel: "stdout", delta: chunk });
    });
    childStderr.on("data", (chunk: string) => {
      stderr.append(chunk);
      report({ type: "output.delta", channel: "stderr", delta: chunk });
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const abort = () => {
      cancelled = true;
      stop();
    };
    abortSignal.addEventListener("abort", abort, { once: true });
    if (abortSignal.aborted) abort();

    const cleanup = () => {
      clearTimeout(timeout);
      if (drainTimer !== undefined) clearTimeout(drainTimer);
      abortSignal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    child.once("error", (error) => {
      fail(
        new CodingToolError(
          "CODING_TOOL_COMMAND_FAILED",
          `shell: unable to start ${profile.displayName}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    child.once("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cancelled) {
        reject(new CodingToolError("CODING_TOOL_CANCELLED", "shell: command was cancelled"));
        return;
      }
      if (timedOut) {
        reject(new CodingToolError("CODING_TOOL_COMMAND_TIMEOUT", `shell: command exceeded ${timeoutMs}ms`));
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

function powerShellScript(command: string): string {
  return (
    "$utf8 = [System.Text.UTF8Encoding]::new($false)\n" +
    "[Console]::OutputEncoding = $utf8\n" +
    "$OutputEncoding = $utf8\n" +
    "$global:LASTEXITCODE = $null\n" +
    command +
    "\n" +
    "$maySucceeded = $?\n" +
    "$mayExitCode = $LASTEXITCODE\n" +
    "if (-not $maySucceeded) {\n" +
    "  if (($null -ne $mayExitCode) -and ($mayExitCode -ne 0)) { exit $mayExitCode }\n" +
    "  exit 1\n" +
    "}\n" +
    "exit 0"
  );
}

function defaultPowerShellExecutable(): string {
  const path = process.env.PATH ?? process.env.Path;
  if (path !== undefined) {
    for (const directory of path.split(delimiter)) {
      if (directory !== "" && existsSync(join(directory, "pwsh.exe"))) {
        return "pwsh.exe";
      }
    }
  }
  return "powershell.exe";
}

function validateShellProfile(profile: ShellProfile): ShellProfile {
  if (profile.displayName.trim() === "") {
    throw new TypeError("Shell profile displayName cannot be empty");
  }
  if (profile.executable.trim() === "") {
    throw new TypeError("Shell profile executable cannot be empty");
  }
  return profile;
}

function terminateProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) {
    child.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => child.kill("SIGKILL"));
    killer.once("exit", (code) => {
      if (code !== 0) child.kill("SIGKILL");
    });
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

interface OutputCollector {
  readonly append: (chunk: Buffer | string) => void;
  readonly text: () => string;
  readonly truncated: () => boolean;
}

function createOutputCollector(maxBytes: number): OutputCollector {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  return {
    append(chunk) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      const remaining = maxBytes - bytes;
      if (remaining > 0) {
        const kept = buffer.subarray(0, remaining);
        chunks.push(kept);
        bytes += kept.byteLength;
      }
      if (buffer.byteLength > remaining) wasTruncated = true;
    },
    text: () => new TextDecoder().decode(Buffer.concat(chunks), { stream: true }),
    truncated: () => wasTruncated,
  };
}

function shellEnvironment(options: ShellToolOptions): NodeJS.ProcessEnv {
  const normalize = (key: string) => (process.platform === "win32" ? key.toUpperCase() : key);
  const allowed = options.envAllowlist?.map(normalize);
  const denied = (options.envDenylist ?? []).map(normalize);
  const result: NodeJS.ProcessEnv = {};
  if (options.inheritEnv !== false && options.execution?.isolation.mode !== "container")
    for (const [key, value] of Object.entries(process.env)) {
      if (allowed !== undefined && !allowed.includes(normalize(key))) continue;
      if (denied.includes(normalize(key)) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|APIKEY)/iu.test(key))
        continue;
      result[key] = value;
    }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    const old = Object.keys(result).find((entry) => normalize(entry) === normalize(key));
    if (old !== undefined) delete result[old];
    if (value !== undefined && !denied.includes(normalize(key))) result[key] = value;
  }
  return result;
}
