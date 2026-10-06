import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import treeKill from "tree-kill";

export interface EvalCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}
export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly processId: number;
  readonly processTerminationConfirmed: boolean;
}
export interface EvalProcess {
  readonly result: Promise<CommandOutcome>;
  cancel(): Promise<boolean>;
}

export function startEvalProcess(command: EvalCommand, signal: AbortSignal): EvalProcess {
  signal.throwIfAborted();
  if (typeof command.executable !== "string" || !command.executable || command.executable.includes("\0") || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new TypeError("Invalid evaluation command");
  if (typeof command.cwd !== "string" || !command.cwd || !isAbsolute(command.cwd) || command.cwd.includes("\0")) throw new TypeError("Evaluation command cwd must be an absolute path");
  for (const [key, value] of Object.entries(command.env ?? {})) if (!key || /[=\0]/u.test(key) || typeof value !== "string" || value.includes("\0")) throw new TypeError("Invalid evaluation command environment");
  const limit = command.maxOutputBytes ?? 262_144;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError("Output limit must be a positive integer");
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, command.env);
  const child = spawn(command.executable, [...command.args], { cwd: command.cwd, env, shell: false, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let finished = false;
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let cancelPromise: Promise<boolean> | undefined;
  function append(current: Buffer, chunk: Buffer) {
    const remaining = Math.max(0, limit - current.length);
    if (chunk.length > remaining) truncated = true;
    return Buffer.concat([current, chunk.subarray(0, remaining)]);
  }
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const cancel = () => {
    if (finished) return Promise.resolve(true);
    if (cancelPromise) return cancelPromise;
    cancelPromise = new Promise<boolean>(accept => {
      if (child.pid === undefined) { accept(false); return; }
      treeKill(child.pid, "SIGKILL", error => { accept(error === undefined); });
    });
    return cancelPromise;
  };
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const result = new Promise<CommandOutcome>((accept, reject) => {
    child.once("error", error => { finished = true; signal.removeEventListener("abort", abort); reject(error); });
    child.once("close", (exitCode, exitSignal) => {
      finished = true;
      signal.removeEventListener("abort", abort);
      if (child.pid === undefined) { reject(new Error("Evaluation process has no identity")); return; }
      accept({ exitCode, signal: exitSignal, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated,
        processId: child.pid, processTerminationConfirmed: true });
    });
  });
  return { result, async cancel() { await cancel(); await result; return finished; } };
}
