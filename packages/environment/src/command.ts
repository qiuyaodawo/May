import { spawn, type ChildProcess } from "node:child_process";

/** 子进程输出与退出结果。 */
export interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** 一次子进程调用的配置。 */
export interface CommandRunOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly input?: string | Uint8Array;
  readonly maxOutputBytes: number;
  readonly captureOutput: boolean;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
  readonly signal?: AbortSignal;
}

export interface RunningCommand {
  readonly child: ChildProcess;
  readonly pid: number | undefined;
}

/**
 * 启动子进程并立即把标准输出与标准错误接出。stdin 写入后关闭。
 */
export function startCommand(
  executable: string,
  args: readonly string[],
  options: CommandRunOptions,
): RunningCommand {
  const child = spawn(executable, [...args], {
    cwd: options.cwd,
    env: { ...options.env },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    // 子进程关闭 stdin 后出现的 EPIPE 属于正常退出过程。
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
  });
  if (options.input !== undefined) child.stdin.write(options.input);
  child.stdin.end();
  if (options.onStdout !== undefined) {
    child.stdout.on("data", (chunk: Buffer) => options.onStdout?.(chunk));
  }
  if (options.onStderr !== undefined) {
    child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk));
  }
  return { child, pid: child.pid };
}

/**
 * 使用 Windows 系统程序终止隔离进程的全部后代。
 */
export async function terminateProcessTree(child: ChildProcess): Promise<boolean> {
  if (child.pid === undefined || child.exitCode !== null) return true;
  if (process.platform === "win32") {
    const windowsDirectory = process.env.SystemRoot;
    if (windowsDirectory === undefined) throw new Error("SystemRoot is required");
    const deadline = Date.now() + 5000;
    // 终止隔离程序，让 runner 正常释放权限和 profile。
    do {
      const query = await runCommand(`${windowsDirectory}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, [
        "-NoProfile", "-NonInteractive", "-Command",
        `ConvertTo-Json -Compress -InputObject @((Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${child.pid}').ProcessId)`,
      ], { cwd: process.cwd(), env: process.env as Record<string, string>, maxOutputBytes: 65536, captureOutput: true });
      if (query.outcome.exitCode !== 0) throw new Error(query.stderr.toString("utf8"));
      const identifiers: number[] = JSON.parse(query.stdout.toString("utf8"));
      if (child.exitCode !== null) return true;
      if (identifiers.length !== 0) {
        for (const identifier of identifiers) {
          const killed = await runCommand(`${windowsDirectory}\\System32\\taskkill.exe`, ["/pid", String(identifier), "/T", "/F"], {
            cwd: process.cwd(), env: process.env as Record<string, string>, maxOutputBytes: 65536, captureOutput: true,
          });
          if (killed.outcome.exitCode !== 0 && child.exitCode === null) return false;
        }
        return true;
      }
    } while (Date.now() < deadline);
    return child.exitCode !== null;
  }
  throw new Error(`native process cancellation does not support ${process.platform}`);
}

/** 有限缓冲的输出收集器。 */
export interface OutputCollector {
  append(chunk: Buffer): void;
  /** 原始字节，截断标记为真时只包含保留的部分。 */
  buffer(): Buffer;
  text(): string;
  bytes(): number;
  truncated(): boolean;
}

export function createOutputCollector(maxBytes: number): OutputCollector {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    append(chunk) {
      if (chunk.length === 0) return;
      const remaining = maxBytes - size;
      if (remaining > 0) {
        const kept = Buffer.from(chunk.subarray(0, remaining));
        chunks.push(kept);
        size += kept.length;
      }
      if (chunk.length > remaining) truncated = true;
    },
    buffer: () => Buffer.concat(chunks),
    text: () => Buffer.concat(chunks).toString("utf8"),
    bytes: () => size,
    truncated: () => truncated,
  };
}

/** 运行一次命令的结果，输出保留原始字节。 */
export interface CommandResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly outcome: CommandOutcome;
}

/**
 * 运行一次命令并收集完整结果。输出保持原始字节，调用方按需解码。
 */
export async function runCommand(
  executable: string,
  args: readonly string[],
  options: CommandRunOptions,
): Promise<CommandResult> {
  const stdout = createOutputCollector(options.maxOutputBytes);
  const stderr = createOutputCollector(options.maxOutputBytes);
  const running = startCommand(executable, args, {
    ...options,
    onStdout: (chunk) => stdout.append(chunk),
    onStderr: (chunk) => stderr.append(chunk),
  });
  return new Promise((resolve, reject) => {
    running.child.once("error", reject);
    running.child.once("close", (exitCode, signal) => {
      resolve({
        stdout: stdout.buffer(),
        stderr: stderr.buffer(),
        outcome: { exitCode, signal: signal ?? null },
      });
    });
  });
}
