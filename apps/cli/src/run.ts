import {
  loadMayConfig,
  type LoadMayConfigOptions,
  type MayConfig,
} from "@may/config";
import { InMemoryContext, May, type Model } from "@may/core";
import type { ProviderAdapterRegistry } from "@may/providers";
import { CLI_USAGE, parseCliArgs } from "./args.js";
import { CliUsageError } from "./errors.js";
import { createConfiguredModel } from "./model.js";
import {
  selectModelConfig,
  type ModelSelector,
  type SelectedModelConfig,
} from "./selection.js";

export interface CliOutput {
  write(text: string): unknown;
}

export interface RunCliDependencies {
  readonly stdout?: CliOutput;
  readonly stderr?: CliOutput;
  readonly signal?: AbortSignal;
  readonly loadConfig?: (
    options?: LoadMayConfigOptions,
  ) => Promise<MayConfig>;
  readonly createModel?: (selection: SelectedModelConfig) => Model;
  readonly adapterRegistry?: ProviderAdapterRegistry;
}

export async function runCli(
  args: readonly string[],
  dependencies: RunCliDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;

  let command;
  try {
    command = parseCliArgs(args);
  } catch (error) {
    if (error instanceof CliUsageError) {
      stderr.write(`Error: ${error.message}\n\n${CLI_USAGE}`);
      return 2;
    }
    throw error;
  }

  if (command.type === "help") {
    stdout.write(CLI_USAGE);
    return 0;
  }

  try {
    const loadConfig = dependencies.loadConfig ?? loadMayConfig;
    const loadOptions: LoadMayConfigOptions = command.configPath === undefined
      ? {}
      : { path: command.configPath };
    const config = await loadConfig(loadOptions);
    const selector: ModelSelector = {
      ...(command.model === undefined ? {} : { model: command.model }),
    };
    const selection = selectModelConfig(config, selector);
    const model = dependencies.createModel === undefined
      ? createConfiguredModel(selection, dependencies.adapterRegistry)
      : dependencies.createModel(selection);

    return await executeRun(
      model,
      command.prompt,
      stdout,
      stderr,
      dependencies.signal,
    );
  } catch (error) {
    if (dependencies.signal?.aborted && (error === dependencies.signal.reason || error instanceof Error && (error.name === "AbortError" || "code" in error && error.code === "RUN_CANCELLED"))) {
      stderr.write("Cancelled\n");
      return 130;
    }
    stderr.write(`Error: ${errorMessage(error)}\n`);
    return 1;
  }
}

async function executeRun(
  model: Model,
  prompt: string,
  stdout: CliOutput,
  stderr: CliOutput,
  signal: AbortSignal | undefined,
): Promise<number> {
  const run = new May({
    model,
    context: new InMemoryContext(),
  }).run(signal === undefined ? { input: prompt } : { input: prompt, signal });
  let wroteReasoning = false;
  let wroteText = false;

  try {
    for await (const event of run.events) {
      if (event.type === "model.reasoning.delta") {
        stderr.write(event.delta);
        wroteReasoning = true;
      } else if (event.type === "model.text.delta") {
        stdout.write(event.delta);
        wroteText = true;
      }
    }

    const result = await run.result;
    if (!wroteText) {
      const finalText = result.message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      if (finalText !== "") {
        stdout.write(finalText);
        wroteText = true;
      }
    }
    return 0;
  } finally {
    if (wroteReasoning) stderr.write("\n");
    if (wroteText) stdout.write("\n");
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
