import { MaybeCodeUsageError } from "./errors.js";

export const MAYBE_CODE_USAGE = `MaybeCode

Usage:
  maybecode [options] [workspace]
  maybecode mcp <login|logout|status> <server-id> [--config <path>]
  maybecode team run <prompt> [--workspace <path>] [--config <path>] [--model <name>]
  maybecode team <resume|status|cancel> <id> [--data-directory <path>]

Options:
  --config <path>      Load another May config file
  --model <name>       Use a named model profile
  --ui <name>          UI implementation: retained (default) or classic
  -c, --continue       Continue the most recent session for this workspace
  -r, --resume <id>    Resume a specific session
  -h, --help           Show this help

MCP login prints a browser authorization URL and waits for a local callback.
MCP commands also accept --workspace <path>; login accepts repeated --scope <scope>.
Team mode is noninteractive and read-only, with isolated copies and durable shared limits.
Team run accepts --max-model-calls <n>, --max-total-tokens <n>, and --max-concurrent <n>.
`;

export interface MaybeCodeHelpCommand {
  readonly type: "help";
}

export interface MaybeCodeStartCommand {
  readonly type: "start";
  readonly workspace?: string;
  readonly configPath?: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly autoResume: boolean;
  readonly ui: MaybeCodeUI;
}

export type MaybeCodeUI = "classic" | "retained";

export interface MaybeCodeMcpCommand {
  readonly type: "mcp";
  readonly action: "login" | "logout" | "status";
  readonly serverId: string;
  readonly configPath?: string;
  readonly workspace?: string;
  readonly scopes?: readonly string[];
}

export interface MaybeCodeTeamCommand {
  readonly type: "team";
  readonly action: "run" | "resume" | "status" | "cancel";
  readonly value: string;
  readonly workspace?: string;
  readonly configPath?: string;
  readonly model?: string;
  readonly dataDirectory?: string;
  readonly maxModelCalls?: number;
  readonly maxTotalTokens?: number;
  readonly maxConcurrent?: number;
}

export type MaybeCodeCommand = MaybeCodeHelpCommand | MaybeCodeStartCommand | MaybeCodeMcpCommand | MaybeCodeTeamCommand;

export function parseMaybeCodeArgs(args: readonly string[]): MaybeCodeCommand {
  if (args[0] === "mcp") return parseMcpCommand(args.slice(1));
  if (args[0] === "team") return parseTeamCommand(args.slice(1));
  let workspace: string | undefined;
  let configPath: string | undefined;
  let model: string | undefined;
  let sessionId: string | undefined;
  let ui: MaybeCodeUI | undefined;
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
    if (argument === "--model") {
      model = setOption(
        "--model",
        model,
        readValue(args, ++index, "--model"),
      );
      continue;
    }
    if (argument === "--ui") {
      const value = readValue(args, ++index, "--ui");
      if (value !== "classic" && value !== "retained") {
        throw new MaybeCodeUsageError(
          '--ui must be either "classic" or "retained"',
        );
      }
      if (ui !== undefined) {
        throw new MaybeCodeUsageError("--ui may only be specified once");
      }
      ui = value;
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

  if (continueLatest && sessionId !== undefined) {
    throw new MaybeCodeUsageError(
      "--continue and --resume cannot be used together",
    );
  }

  return {
    type: "start",
    autoResume: continueLatest,
    ui: ui ?? "retained",
    ...(workspace === undefined ? {} : { workspace }),
    ...(configPath === undefined ? {} : { configPath }),
    ...(model === undefined ? {} : { model }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function parseTeamCommand(args: readonly string[]): MaybeCodeTeamCommand | MaybeCodeHelpCommand {
  if (args.includes("--help") || args.includes("-h")) return { type: "help" };
  const [action, value] = args;
  if (!["run", "resume", "status", "cancel"].includes(action ?? "") || !value?.trim() || value.startsWith("--")) {
    throw new MaybeCodeUsageError("Use team run <prompt> or team <resume|status|cancel> <id>");
  }
  if (action !== "run" && !/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new MaybeCodeUsageError("Invalid team id");
  const strings: Record<string, string> = {};
  const numbers: Record<string, number> = {};
  for (let index = 2; index < args.length; index++) {
    const option = args[index]!;
    const key = ({ "--workspace": "workspace", "--config": "configPath", "--model": "model", "--data-directory": "dataDirectory" } as Record<string, string>)[option];
    if (key && (action === "run" || key === "dataDirectory")) {
      strings[key] = setOption(option, strings[key], readValue(args, ++index, option));
      continue;
    }
    const numericKey = ({ "--max-model-calls": "maxModelCalls", "--max-total-tokens": "maxTotalTokens", "--max-concurrent": "maxConcurrent" } as Record<string, string>)[option];
    if (numericKey && action === "run") {
      if (numbers[numericKey] !== undefined) throw new MaybeCodeUsageError(`${option} may only be specified once`);
      const raw = readValue(args, ++index, option);
      const number = Number(raw);
      if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(number) || number < 1 || (numericKey === "maxConcurrent" && number > 8)) {
        throw new MaybeCodeUsageError(`${option} requires a positive integer${numericKey === "maxConcurrent" ? " no greater than 8" : ""}`);
      }
      numbers[numericKey] = number;
      continue;
    }
    throw new MaybeCodeUsageError(`Unsupported team option "${option}"`);
  }
  return { type: "team", action: action as MaybeCodeTeamCommand["action"], value, ...strings, ...numbers };
}

function parseMcpCommand(args: readonly string[]): MaybeCodeMcpCommand | MaybeCodeHelpCommand {
  if (args.includes("--help") || args.includes("-h")) return { type: "help" };
  const [action, serverId] = args;
  if (!["login", "logout", "status"].includes(action ?? "") || !serverId || !/^[A-Za-z0-9_-]+$/u.test(serverId)) {
    throw new MaybeCodeUsageError("Use mcp <login|logout|status> <server-id>");
  }
  let configPath: string | undefined;
  let workspace: string | undefined;
  const scopes: string[] = [];
  for (let i = 2; i < args.length; i++) {
    const name = args[i]!;
    if (name === "--config") configPath = setOption(name, configPath, readValue(args, ++i, name));
    else if (name === "--workspace") workspace = setOption(name, workspace, readValue(args, ++i, name));
    else if (name === "--scope" && action === "login") scopes.push(readValue(args, ++i, name));
    else throw new MaybeCodeUsageError(`Unsupported MCP option "${name}"`);
  }
  return {
    type: "mcp", action: action as MaybeCodeMcpCommand["action"], serverId,
    ...(configPath === undefined ? {} : { configPath }),
    ...(workspace === undefined ? {} : { workspace }),
    ...(scopes.length === 0 ? {} : { scopes }),
  };
}

function readValue(
  args: readonly string[],
  index: number,
  option: string,
): string {
  const value = args[index];
  if (
    value === undefined || value.trim() === "" || value.startsWith("-")
  ) {
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
