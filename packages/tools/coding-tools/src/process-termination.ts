import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { hasErrorCode } from "@sortedyuan/may/storage";
import { CodingToolError } from "./errors.js";

const DEFAULT_TERMINATION_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 10;

export interface ProcessGroupWaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface WindowsTerminationOptions {
  readonly timeoutMs?: number;
  readonly spawnTaskkill?: (pid: number, timeoutMs: number) => ChildProcess;
}

let activeHostProcessCloseTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS;
const abandonedChildListeners = new WeakMap<ChildProcess, Set<(error: unknown) => void>>();

/** Internal test seam for host pipe-close timeout (not re-exported from package index). */
export function setHostProcessCloseTimeoutForTesting(timeoutMs?: number): void {
  activeHostProcessCloseTimeoutMs = timeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
}

export function getHostProcessCloseTimeoutMs(): number {
  return activeHostProcessCloseTimeoutMs;
}

/** Internal hook letting shell commands fail immediately when host cleanup abandons a child. */
export function onHostChildAbandoned(child: ChildProcess, listener: (error: unknown) => void): () => void {
  let listeners = abandonedChildListeners.get(child);
  if (listeners === undefined) {
    listeners = new Set();
    abandonedChildListeners.set(child, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyHostChildAbandoned(child: ChildProcess, error: unknown): void {
  const listeners = abandonedChildListeners.get(child);
  if (listeners === undefined) return;
  abandonedChildListeners.delete(child);
  for (const listener of listeners) {
    listener(error);
  }
}

/**
 * Spawn a short-lived probe command with a hard wall-clock deadline. Unlike `execFile({ timeout })`,
 * expiry immediately rejects, sends `SIGKILL`, destroys stdout, and unrefs the child so a hung
 * or SIGTERM-ignoring probe process can never outlast the cleanup budget.
 */
export function runBoundedCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  timeoutMessage = `Command ${command} timed out after ${timeoutMs}ms`,
): Promise<string> {
  const limitMs = Math.max(1, Math.ceil(timeoutMs));
  return new Promise<string>((resolveOutput, rejectOutput) => {
    const child = spawn(command, [...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let settled = false;
    let stdout = "";
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process may have already exited.
        }
        child.stdout?.destroy();
        child.unref();
        rejectOutput(new CodingToolError("CODING_EXECUTION_TERMINATION_TIMEOUT", timeoutMessage));
      });
    }, limitMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      finish(() => rejectOutput(error));
    });
    child.once("close", (code, signal) => {
      finish(() => {
        if (signal !== null) {
          rejectOutput(new CodingToolError("CODING_EXECUTION_TERMINATION_TIMEOUT", timeoutMessage));
        } else if (code !== 0) {
          rejectOutput(new Error(`Command ${command} exited with code ${String(code)}`));
        } else {
          resolveOutput(stdout);
        }
      });
    });
  });
}

/**
 * Wait until a POSIX process group has exited, bounded by `timeoutMs` so an
 * unkillable process (or hung `/bin/ps` on macOS) never hangs environment cleanup indefinitely.
 */
export async function waitForProcessGroupExit(pid: number, options: ProcessGroupWaitOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) return;
      if (process.platform !== "darwin" || !hasErrorCode(error, "EPERM")) throw error;
      const remainingBeforePs = deadline - performance.now();
      if (remainingBeforePs <= 0) {
        throw new CodingToolError(
          "CODING_EXECUTION_TERMINATION_TIMEOUT",
          `Process group ${pid} did not terminate within ${timeoutMs}ms`,
        );
      }
      let stdout: string;
      try {
        stdout = await runBoundedCommand(
          "/bin/ps",
          ["-A", "-o", "pgid="],
          remainingBeforePs,
          `Process group ${pid} did not terminate within ${timeoutMs}ms`,
        );
      } catch (psError) {
        if (psError instanceof CodingToolError && psError.code === "CODING_EXECUTION_TERMINATION_TIMEOUT") {
          throw psError;
        }
        if (deadline - performance.now() <= 0) {
          throw new CodingToolError(
            "CODING_EXECUTION_TERMINATION_TIMEOUT",
            `Process group ${pid} did not terminate within ${timeoutMs}ms`,
            { cause: psError },
          );
        }
        throw psError;
      }
      if (!stdout.split(/\s+/u).includes(String(pid))) return;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      throw new CodingToolError(
        "CODING_EXECUTION_TERMINATION_TIMEOUT",
        `Process group ${pid} did not terminate within ${timeoutMs}ms`,
      );
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, remaining)));
  }
}

export async function terminateWindowsProcessTree(pid: number, options: WindowsTerminationOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
  const limitMs = Math.max(1, Math.ceil(timeoutMs));
  const spawnTaskkill =
    options.spawnTaskkill ??
    ((targetPid: number) =>
      spawn("taskkill", ["/pid", String(targetPid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      }));

  const killer = spawnTaskkill(pid, limitMs);
  const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveStop, rejectStop) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => {
          try {
            killer.kill("SIGKILL");
          } catch {
            // Helper may have already exited.
          }
          killer.unref();
          rejectStop(
            new CodingToolError(
              "CODING_EXECUTION_TERMINATION_TIMEOUT",
              `Windows taskkill timed out after ${timeoutMs}ms while terminating process tree ${pid}`,
            ),
          );
        });
      }, limitMs);
      timer.unref();
      killer.once("error", (error) => {
        finish(() => {
          killer.unref();
          rejectStop(error);
        });
      });
      killer.once("close", (exitCode, exitSignal) => {
        finish(() => resolveStop({ code: exitCode, signal: exitSignal }));
      });
    },
  );
  if (signal !== null) {
    throw new CodingToolError(
      "CODING_EXECUTION_TERMINATION_TIMEOUT",
      `Windows taskkill timed out after ${timeoutMs}ms while terminating process tree ${pid}`,
    );
  }
  if (code === 0) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return;
  }
  throw new CodingToolError(
    "CODING_EXECUTION_TERMINATION_FAILED",
    `Windows taskkill failed with exit code ${String(code)} while terminating process tree ${pid}`,
  );
}

export async function terminateHostProcess(pid: number, timeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS): Promise<void> {
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(pid, { timeoutMs });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) return;
    throw error;
  }
  await waitForProcessGroupExit(pid, { timeoutMs });
}
