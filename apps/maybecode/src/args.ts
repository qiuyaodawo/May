import { MaybeCodeUsageError } from "./errors.js";

export const MAYBE_CODE_USAGE = `MaybeCode

Usage:
  maybecode [options] [workspace]

Options:
  --config <path>      Load another May config file
  --provider <name>    Use a configured provider
  --model <name>       Use a named model profile
  -c, --continue       Continue the most recent session for this workspace
  -r, --resume <id>    Resume a specific session
  -h, --help           Show this help
`;

export interface MaybeCodeHelpCommand {
  readonly type: "help";
}

export interface MaybeCodeStartCommand {
  readonly type: "start";
  readonly workspace?: string;
  readonly configPath?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly autoResume: boolean;
}

export type MaybeCodeCommand = MaybeCodeHelpCommand | MaybeCodeStartCommand;

export function parseMaybeCodeArgs(args: readonly string[]): MaybeCodeCommand {
  let workspace: string | undefined;
  let configPath: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let sessionId: string | undefined;
  let continueLatest = false;

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") return { type: "help" };
    if (argument === "--continue" || argument === "-c") {
      if (continueLatest) {
        throw new MaybeCodeUsageError("--continue may only be specified once");
      }
      continueLatest = true;
      continue;
    }
    if (argument === "--config") {
      configPath = setOption(
        "--config",
        configPath,
        readValue(args, ++index, "--config"),
      );
      continue;
    }
    if (argument === "--provider") {
      provider = setOption(
        "--provider",
        provider,
        readValue(args, ++index, "--provider"),
      );
      continue;
    }
    if (argument === "--model") {
      model = setOption(
        "--model",
        model,
        readValue(args, ++index, "--model"),
      );
      continue;
    }
    if (
      argument === "--resume" ||
      argument === "-r" ||
      argument === "--session"
    ) {
      sessionId = setOption(
        "--resume",
        sessionId,
        readValue(args, ++index, "--resume"),
      );
      continue;
    }
    if (argument.startsWith("-")) {
      throw new MaybeCodeUsageError(`Unknown option "${argument}"`);
    }
    if (workspace !== undefined) {
      throw new MaybeCodeUsageError("Only one workspace may be specified");
    }
    workspace = argument;
  }

  if (provider !== undefined && model !== undefined) {
    throw new MaybeCodeUsageError("--provider and --model cannot be used together");
  }
  if (continueLatest && sessionId !== undefined) {
    throw new MaybeCodeUsageError(
      "--continue and --resume cannot be used together",
    );
  }

  return {
    type: "start",
    autoResume: continueLatest,
    ...(workspace === undefined ? {} : { workspace }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function readValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (value === undefined || value.trim() === "") {
    throw new MaybeCodeUsageError(`${option} requires a value`);
  }
  return value;
}

function setOption(
  option: string,
  current: string | undefined,
  value: string,
): string {
  if (current !== undefined) {
    throw new MaybeCodeUsageError(`${option} may only be specified once`);
  }
  return value;
}
