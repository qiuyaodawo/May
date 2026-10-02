import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createOutputCollector, terminateProcessTree } from "./command.js";
import {
  EnvironmentError,
  EnvironmentProcessCancelledError,
  EnvironmentProcessTimeoutError,
} from "./errors.js";
import type {
  EnvironmentOutputChunk,
  EnvironmentProcess,
  EnvironmentProcessCancellation,
  EnvironmentProcessResult,
  EnvironmentProcessState,
  EnvironmentProcessStatusSnapshot,
} from "./types.js";

export const DEFAULT_PROCESS_TIMEOUT_MS = 120_000;
export const DEFAULT_PROCESS_CANCEL_GRACE_MS = 5_000;
export const DEFAULT_PROCESS_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface EnvironmentProcessStart {
  readonly processId: string;
  readonly command: readonly string[];
  readonly child: ChildProcess;
  readonly maxOutputBytes: number;
  readonly captureOutput: boolean;
  readonly cancelGraceMs: number;
}

/**
 * 进程句柄：输出、结果、状态查询与取消都在同一个句柄上。
 *
 * 取消请求先记录再终止进程，结算只在确认终止之后进行。
 */
export class EnvironmentProcessHandle implements EnvironmentProcess {
  readonly processId: string;
  readonly command: readonly string[];
  readonly result: Promise<EnvironmentProcessResult>;

  readonly #child: ChildProcess;
  readonly #cancelGraceMs: number;
  readonly #captureOutput: boolean;
  readonly #maxOutputBytes: number;
  readonly #stdout: ReturnType<typeof createOutputCollector>;
  readonly #stderr: ReturnType<typeof createOutputCollector>;
  readonly #stdoutDecoder = new StringDecoder("utf8");
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #outputListeners = new Set<(chunk: EnvironmentOutputChunk) => void>();
  readonly #statusListeners = new Set<
    (status: EnvironmentProcessStatusSnapshot) => void
  >();
  readonly #startedAt = new Date().toISOString();
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #state: EnvironmentProcessState = "running";
  #exitCode: number | null = null;
  #signal: string | null = null;
  #endedAt: string | undefined;
  #cancellation: EnvironmentProcessCancellation | undefined;
  #cancellationInFlight = false;
  #timedOut = false;
  #cancelPromise: Promise<EnvironmentProcessCancellation> | undefined;
  #settled = false;
  #settle: ((outcome: CommandOutcome) => void) | undefined;
  #startFailure: Error | undefined;

  constructor(start: EnvironmentProcessStart) {
    this.processId = start.processId;
    this.command = start.command;
    this.#child = start.child;
    this.#cancelGraceMs = start.cancelGraceMs;
    this.#captureOutput = start.captureOutput;
    this.#maxOutputBytes = start.maxOutputBytes;
    const maxBytes = start.captureOutput ? start.maxOutputBytes : 0;
    this.#stdout = createOutputCollector(maxBytes);
    this.#stderr = createOutputCollector(maxBytes);

    this.result = new Promise<EnvironmentProcessResult>((resolve, reject) => {
      this.#settle = (outcome) => {
        if (this.#settled) return;
        this.#settled = true;
        const result = this.#buildResult(outcome);
        if (this.#startFailure !== undefined) {
          reject(this.#startFailure);
          return;
        }
        const cancellation = this.#cancellation;
        if (cancellation !== undefined) {
          if (!cancellation.confirmed) {
            reject(new EnvironmentError(
              "ENVIRONMENT_PROCESS_CANCEL_UNCONFIRMED",
              `cancellation of process ${this.processId} could not be confirmed`,
            ));
            return;
          }
          const CancelError = this.#timedOut ? EnvironmentProcessTimeoutError : EnvironmentProcessCancelledError;
          reject(new CancelError(
            `process ${this.processId} was cancelled: ${cancellation.reason}`,
            result,
          ));
          return;
        }
        resolve(result);
      };
    });
    this.result.catch(() => undefined);

    this.#child.stdout?.on("data", (chunk: Buffer) => this.#onChunk("stdout", chunk));
    this.#child.stderr?.on("data", (chunk: Buffer) => this.#onChunk("stderr", chunk));
    this.#child.once("error", (error) => {
      this.#startFailure = new EnvironmentError(
        "ENVIRONMENT_PROCESS_START_FAILED",
        `unable to start ${this.command[0] ?? "process"}: ${error.message}`,
        { cause: error },
      );
      this.#state = "failed";
      this.#endedAt = new Date().toISOString();
      this.#emitStatus();
      if (!this.#cancellationInFlight) {
        this.#settle?.({ exitCode: null, signal: null });
      }
    });
    this.#child.once("close", (exitCode, signal) => {
      this.#flushDecoders();
      this.#exitCode = exitCode;
      this.#signal = signal ?? null;
      this.#endedAt = new Date().toISOString();
      if (!this.#cancellationInFlight) {
        if (this.#state === "running") this.#state = "exited";
        this.#emitStatus();
        this.#settle?.({ exitCode, signal: signal ?? null });
      }
    });
    this.#emitStatus();
  }

  status(): EnvironmentProcessStatusSnapshot {
    return {
      processId: this.processId,
      state: this.#state,
      command: [...this.command],
      startedAt: this.#startedAt,
      ...(this.#endedAt === undefined ? {} : { endedAt: this.#endedAt }),
      exitCode: this.#exitCode,
      signal: this.#signal,
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      ...(this.#cancellation === undefined ? {} : { cancellation: this.#cancellation }),
    };
  }

  waitForExit(): Promise<EnvironmentProcessResult> {
    return this.result;
  }

  markTimedOut(): void {
    this.#timedOut = true;
  }

  cancel(reason = "cancelled by host"): Promise<EnvironmentProcessCancellation> {
    this.#cancelPromise ??= this.#cancel(reason);
    return this.#cancelPromise;
  }

  onOutput(listener: (chunk: EnvironmentOutputChunk) => void): () => void {
    this.#outputListeners.add(listener);
    return () => {
      this.#outputListeners.delete(listener);
    };
  }

  onStatusChange(
    listener: (status: EnvironmentProcessStatusSnapshot) => void,
  ): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  #onChunk(channel: "stdout" | "stderr", chunk: Buffer): void {
    if (channel === "stdout") {
      this.#stdoutBytes += chunk.length;
      if (this.#captureOutput) this.#stdout.append(chunk);
    } else {
      this.#stderrBytes += chunk.length;
      if (this.#captureOutput) this.#stderr.append(chunk);
    }
    const bytes = Uint8Array.prototype.slice.call(chunk);
    const event: EnvironmentOutputChunk = {
      channel,
      bytes,
      // 跨 chunk 的 UTF-8 需要增量解码，避免切断多字节字符。
      text: channel === "stdout"
        ? this.#stdoutDecoder.write(Buffer.from(bytes))
        : this.#stderrDecoder.write(Buffer.from(bytes)),
    };
    for (const listener of [...this.#outputListeners]) listener(event);
  }

  /** 输出结束时冲刷解码器，返回末尾不完整字符产生的替换内容。 */
  #flushDecoders(): void {
    const stdoutRest = this.#stdoutDecoder.end();
    const stderrRest = this.#stderrDecoder.end();
    for (const [channel, text] of [["stdout", stdoutRest], ["stderr", stderrRest]] as const) {
      if (text === "") continue;
      const event: EnvironmentOutputChunk = { channel, bytes: new Uint8Array(), text };
      for (const listener of [...this.#outputListeners]) listener(event);
    }
  }

  #emitStatus(): void {
    const snapshot = this.status();
    for (const listener of [...this.#statusListeners]) listener(snapshot);
  }

  #buildResult(outcome: CommandOutcome): EnvironmentProcessResult {
    return {
      processId: this.processId,
      command: [...this.command],
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: this.#stdout.text(),
      stderr: this.#stderr.text(),
      stdoutData: this.#captureOutput ? new Uint8Array(this.#stdout.buffer()) : new Uint8Array(),
      stderrData: this.#captureOutput ? new Uint8Array(this.#stderr.buffer()) : new Uint8Array(),
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      stdoutTruncated: this.#stdout.truncated(),
      stderrTruncated: this.#stderr.truncated(),
      startedAt: this.#startedAt,
      endedAt: this.#endedAt ?? new Date().toISOString(),
    };
  }

  async #cancel(reason: string): Promise<EnvironmentProcessCancellation> {
    const requestedAt = new Date().toISOString();
    if (this.#endedAt !== undefined && !this.#cancellationInFlight) {
      const cancellation: EnvironmentProcessCancellation = {
        reason,
        requestedAt,
        confirmed: true,
        stoppedAt: new Date().toISOString(),
      };
      this.#cancellation = cancellation;
      this.#emitStatus();
      return cancellation;
    }
    this.#cancellationInFlight = true;
    this.#cancellation = { reason, requestedAt, confirmed: false };
    this.#state = "stopping";
    this.#emitStatus();
    let terminated: boolean;
    try {
      terminated = await terminateProcessTree(this.#child);
    } catch (error) {
      this.#cancellationInFlight = false;
      this.#settle?.({ exitCode: this.#exitCode, signal: this.#signal });
      throw error;
    }
    const closed = await this.#waitForClose(this.#cancelGraceMs);
    const cancellation: EnvironmentProcessCancellation = {
      reason,
      requestedAt,
      confirmed: terminated && closed,
      ...(closed ? { stoppedAt: new Date().toISOString() } : {}),
    };
    this.#cancellation = cancellation;
    this.#state = cancellation.confirmed ? "cancelled" : "stopping";
    this.#emitStatus();
    this.#cancellationInFlight = false;
    this.#settle?.({ exitCode: this.#exitCode, signal: this.#signal });
    return cancellation;
  }

  #waitForClose(timeoutMs: number): Promise<boolean> {
    if (this.#endedAt !== undefined) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.#child.removeListener("close", onClose);
        resolve(false);
      }, timeoutMs);
      this.#child.once("close", onClose);
    });
  }
}

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
}
