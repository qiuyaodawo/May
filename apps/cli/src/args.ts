import { CliUsageError } from "./errors.js";

export const CLI_USAGE = `May CLI

Usage:
  may run [options] <prompt>

Options:
  --config <path>      Load another config file
  --provider <name>    Use a provider and its configured model
  --model <name>       Use a named model profile
  -h, --help           Show this help
`;

export interface HelpCommand {
  readonly type: "help";
}

export interface RunCommand {
  readonly type: "run";
  readonly prompt: string;
  readonly configPath?: string;
  readonly provider?: string;
  readonly model?: string;
}

export type CliCommand = HelpCommand | RunCommand;

export function parseCliArgs(args: readonly string[]): CliCommand {
  if (
    args.length === 0 || args[0] === "help" || args[0] === "--help" ||
    args[0] === "-h"
  ) {
    return { type: "help" };
  }
  if (args[0] !== "run") {
    throw new CliUsageError(`Unknown command "${args[0]}"`);
  }

  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let parseOptions = true;
  const prompt: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const argument = args[index]!;
    if (parseOptions && argument === "--") {
      parseOptions = false;
      continue;
    }
    if (parseOptions && (argument === "--help" || argument === "-h")) {
      return { type: "help" };
    }
    if (parseOptions && argument === "--config") {
      configPath = setOption(
        "--config",
        configPath,
        readOptionValue(args, ++index, "--config"),
      );
      continue;
    }
    if (parseOptions && argument === "--provider") {
      provider = setOption(
        "--provider",
        provider,
        readOptionValue(args, ++index, "--provider"),
      );
      continue;
    }
    if (parseOptions && argument === "--model") {
      model = setOption(
        "--model",
        model,
        readOptionValue(args, ++index, "--model"),
      );
      continue;
    }
    if (parseOptions && argument.startsWith("-")) {
      throw new CliUsageError(`Unknown option "${argument}"`);
    }
    prompt.push(argument);
  }

  if (provider !== undefined && model !== undefined) {
    throw new CliUsageError("--provider and --model cannot be used together");
  }

  const input = prompt.join(" ").trim();
  if (input === "") {
    throw new CliUsageError("A prompt is required");
  }

  return createRunCommand(input, configPath, provider, model);
}

function readOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (value === undefined || value.trim() === "") {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
}

function setOption(
  option: string,
  current: string | undefined,
  value: string,
): string {
  if (current !== undefined) {
    throw new CliUsageError(`${option} may only be specified once`);
  }
  return value;
}

function createRunCommand(
  prompt: string,
  configPath: string | undefined,
  provider: string | undefined,
  model: string | undefined,
): RunCommand {
  return {
    type: "run",
    prompt,
    ...(configPath === undefined ? {} : { configPath }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  };
}
