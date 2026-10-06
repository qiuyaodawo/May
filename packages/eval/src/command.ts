import { performance } from "node:perf_hooks";
import { isAbsolute } from "node:path";
import type { EvalExecutionAdapter, ExecutionCreateContext } from "./types.js";
import { startEvalProcess, type CommandOutcome, type EvalCommand, type EvalProcess } from "./process.js";

export interface CommandExecutionAdapterOptions {
  readonly id: string;
  readonly version: string;
  readonly command: (context: ExecutionCreateContext) => EvalCommand;
  readonly validate?: EvalExecutionAdapter["validate"];
  readonly confirmTermination?: (bindings: { readonly context: ExecutionCreateContext; readonly command: EvalCommand; readonly outcome: CommandOutcome; readonly signal: AbortSignal }) => boolean | Promise<boolean>;
}

export function createCommandExecutionAdapter(options: CommandExecutionAdapterOptions): EvalExecutionAdapter {
  return {
    id: options.id, version: options.version,
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    async create(context) {
      let active: EvalProcess | undefined;
      let command: EvalCommand | undefined;
      let used = false;
      async function confirm(signal: AbortSignal) {
        signal.throwIfAborted();
        if (active === undefined) return true;
        const outcome = await active.result;
        if (options.confirmTermination === undefined) return false;
        const confirmed = await options.confirmTermination({ context, command: command!, outcome, signal });
        if (typeof confirmed !== "boolean") throw new TypeError("Command termination verifier must return a boolean");
        return outcome.processTerminationConfirmed && confirmed;
      }
      return {
        async execute(signal) {
          if (used) throw new Error("A trial execution can only be started once");
          used = true;
          const started = performance.now();
          command = options.command(context);
          active = startEvalProcess(command, signal);
          const outcome = await active.result;
          const terminationConfirmed = signal.aborted ? false : await confirm(signal);
          const metrics = { durationMs: { value: performance.now() - started, complete: true, missingReasons: [] } };
          return { status: signal.aborted ? "cancelled" as const : outcome.exitCode === 0 ? "completed" as const : "failed" as const,
            terminationConfirmed, metrics,
            output: { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr, truncated: outcome.truncated },
            ...(outcome.exitCode === 0 ? {} : { reason: "command-failed" }) };
        },
        async cancel(signal) { signal.throwIfAborted(); return { confirmed: (active === undefined || await active.cancel()) && await confirm(signal) }; },
        async close(signal) { signal.throwIfAborted(); if (active !== undefined && (!await active.cancel() || !await confirm(signal))) throw new Error("Command termination could not be confirmed"); },
      };
    },
  };
}

export interface NodeEvalCommand {
  readonly script: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}

export function createNodeCommandExecutionAdapter(options: {
  readonly id: string;
  readonly version: string;
  readonly command: (context: ExecutionCreateContext) => NodeEvalCommand;
  readonly validate?: EvalExecutionAdapter["validate"];
}): EvalExecutionAdapter {
  return createCommandExecutionAdapter({
    id: options.id, version: options.version,
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    command: context => nodeEvalCommand(options.command(context)),
    confirmTermination: ({ outcome }) => outcome.processTerminationConfirmed,
  });
}

export function nodeEvalCommand(command: NodeEvalCommand): EvalCommand {
  if (typeof command.script !== "string" || !isAbsolute(command.script) || command.script.includes("\0")) throw new TypeError("Node evaluation script must be an absolute path");
  if (typeof command.cwd !== "string" || !isAbsolute(command.cwd) || command.cwd.includes("\0")) throw new TypeError("Node evaluation cwd must be an absolute path");
  if (Object.keys(command.env ?? {}).some(key => /^NODE_(OPTIONS|PATH)$/iu.test(key))) throw new TypeError("Node evaluation environment cannot override Node runtime options");
  return { executable: process.execPath,
    args: ["--permission", `--allow-fs-read=${command.script}`, `--allow-fs-read=${command.cwd}`, `--allow-fs-write=${command.cwd}`, command.script, ...(command.args ?? [])],
    cwd: command.cwd,
    ...(command.env === undefined ? {} : { env: command.env }),
    ...(command.maxOutputBytes === undefined ? {} : { maxOutputBytes: command.maxOutputBytes }),
  };
}
