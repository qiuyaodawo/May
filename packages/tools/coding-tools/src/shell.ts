import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Tool, ToolProgressUpdate } from "@may/core";
import { CodingToolError } from "./errors.js";
import {
  optionalPositiveInteger,
  requireObject,
  requirePositiveIntegerOption,
  requireString,
} from "./input.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 120_000;
export const DEFAULT_SHELL_MAX_TIMEOUT_MS = 600_000;
export const DEFAULT_SHELL_MAX_OUTPUT_BYTES = 1024 * 1024;

export type ShellKind = "powershell" | "bash" | "custom";

export interface ShellProfile {
  readonly kind: ShellKind;
  readonly displayName: string;
  readonly executable: string;
  readonly args: (command: string) => readonly string[];
}

export interface ShellToolInfo {
  readonly kind: ShellKind;
  readonly displayName: string;
  readonly executable: string;
}

export interface ShellToolOptions {
  readonly cwd: string;
  readonly defaultTimeoutMs?: number;
  readonly maxTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly profile?: ShellProfile;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
  readonly inheritEnv?: boolean;
  readonly envAllowlist?: readonly string[];
  readonly envDenylist?: readonly string[];
}

export interface ShellToolInput {
  readonly command: string;
  readonly timeoutMs?: number;
}

export interface ShellToolOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

const shellToolInfo = new WeakMap<object, ShellToolInfo>();

export function createDefaultShellProfile(
  platform: NodeJS.Platform = process.platform,
): ShellProfile {
  return platform === "win32"
    ? createPowerShellProfile()
    : createBashShellProfile();
}

export function createPowerShellProfile(
  options: { readonly executable?: string; readonly displayName?: string } = {},
): ShellProfile {
  const executable = options.executable ?? defaultPowerShellExecutable();
  const displayName = options.displayName ??
    (/(?:^|[\\/])pwsh(?:\.exe)?$/iu.test(executable)
      ? "PowerShell 7"
      : "Windows PowerShell");
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

export function createShellTool(options: ShellToolOptions): Tool<
  ShellToolInput,
  ShellToolOutput
> {
  const defaultTimeoutMs = requirePositiveIntegerOption(
    options.defaultTimeoutMs,
    DEFAULT_SHELL_TIMEOUT_MS,
    "defaultTimeoutMs",
  );
  const maxTimeoutMs = requirePositiveIntegerOption(
    options.maxTimeoutMs,
    DEFAULT_SHELL_MAX_TIMEOUT_MS,
    "maxTimeoutMs",
  );
  const maxOutputBytes = requirePositiveIntegerOption(
    options.maxOutputBytes,
    DEFAULT_SHELL_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  if (defaultTimeoutMs > maxTimeoutMs) {
    throw new RangeError("defaultTimeoutMs must not exceed maxTimeoutMs");
  }
  const profile = validateShellProfile(
    options.profile ?? createDefaultShellProfile(),
  );
  const info: ShellToolInfo = {
    kind: profile.kind,
    displayName: profile.displayName,
    executable: profile.executable,
  };

  const tool: Tool<ShellToolInput, ShellToolOutput> = {
    name: "shell",
    description: shellDescription(info),
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
      const timeoutMs = optionalPositiveInteger(
        value.timeoutMs,
        "shell",
        "timeoutMs",
      );
      if (timeoutMs !== undefined && timeoutMs > maxTimeoutMs) {
        throw new CodingToolError(
          "CODING_TOOL_INVALID_INPUT",
          `shell: timeoutMs must not exceed ${maxTimeoutMs}`,
        );
      }
      return {
        command,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      };
    },
    async execute(input, context) {
      if (context.signal.aborted) {
        throw new CodingToolError(
          "CODING_TOOL_CANCELLED",
          "shell: command was cancelled",
        );
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
  shellToolInfo.set(tool, info);
  return tool;
}

export function getShellToolInfo(tool: Tool): ShellToolInfo | undefined {
  const info = shellToolInfo.get(tool);
  return info === undefined ? undefined : { ...info };
}

export function shellRuntimeInstructions(info: ShellToolInfo): string {
  if (info.kind === "powershell") {
    return `The shell tool runs ${info.displayName} on Windows. ` +
      "Use PowerShell syntax and cmdlets; do not assume POSIX utilities such " +
      "as ls, find, or head are installed.";
  }
  if (info.kind === "bash") {
    return `The shell tool runs ${info.displayName}. Use Bash syntax.`;
  }
  return `The shell tool runs ${info.displayName}. Follow that shell's syntax.`;
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
    const child = spawn(profile.executable, [...profile.args(command)], {
      cwd,
      shell: false,
      env: shellEnvironment(options),
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createOutputCollector(maxOutputBytes);
    const stderr = createOutputCollector(maxOutputBytes);
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      terminateProcessTree(child);
      drainTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        fail(new CodingToolError(cancelled ? "CODING_TOOL_CANCELLED" : "CODING_TOOL_COMMAND_TIMEOUT", "shell: command stopped; process-tree termination could not be confirmed"));
      }, 1000);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout.append(chunk);
      report({ type: "output.delta", channel: "stdout", delta: chunk });
    });
    child.stderr.on("data", (chunk: string) => {
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
      fail(new CodingToolError(
        "CODING_TOOL_COMMAND_FAILED",
        `shell: unable to start ${profile.displayName}: ${error.message}`,
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
          "shell: command was cancelled",
        ));
        return;
      }
      if (timedOut) {
        reject(new CodingToolError(
          "CODING_TOOL_COMMAND_TIMEOUT",
          `shell: command exceeded ${timeoutMs}ms`,
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

function powerShellScript(command: string): string {
  return "$utf8 = [System.Text.UTF8Encoding]::new($false)\n" +
    "[Console]::OutputEncoding = $utf8\n" +
    "$OutputEncoding = $utf8\n" +
    "$global:LASTEXITCODE = $null\n" +
    "& {\n" + command + "\n}\n" +
    "$maySucceeded = $?\n" +
    "$mayExitCode = $LASTEXITCODE\n" +
    "if ($null -ne $mayExitCode) { exit $mayExitCode }\n" +
    "if (-not $maySucceeded) { exit 1 }";
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

function shellDescription(info: ShellToolInfo): string {
  const syntax = info.kind === "powershell"
    ? "Use PowerShell syntax and cmdlets, not Bash syntax."
    : info.kind === "bash"
    ? "Use Bash syntax."
    : `Use ${info.displayName} syntax.`;
  return `Execute a ${info.displayName} command in the workspace. ` +
    `${syntax} This is not a sandbox.`;
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
    const killer = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", () => child.kill("SIGKILL"));
    killer.once("exit", (code) => { if (code !== 0) child.kill("SIGKILL"); });
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
  const normalize = (key: string) => process.platform === "win32" ? key.toUpperCase() : key;
  const allowed = options.envAllowlist?.map(normalize);
  const denied = (options.envDenylist ?? []).map(normalize);
  const result: NodeJS.ProcessEnv = {};
  if (options.inheritEnv !== false) for (const [key, value] of Object.entries(process.env)) {
    if (allowed !== undefined && !allowed.includes(normalize(key))) continue;
    if (denied.includes(normalize(key)) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|APIKEY)/iu.test(key)) continue;
    result[key] = value;
  }
  for (const [key, value] of Object.entries(options.env ?? {})) {
    const old = Object.keys(result).find((entry) => normalize(entry) === normalize(key));
    if (old !== undefined) delete result[old];
    if (value !== undefined && !denied.includes(normalize(key))) result[key] = value;
  }
  return result;
}
