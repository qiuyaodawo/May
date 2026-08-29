import {
  MAYBE_CODE_USAGE,
  parseMaybeCodeArgs,
} from "./args.js";
import {
  openConfiguredMaybeCode,
  type OpenConfiguredMaybeCodeOptions,
} from "./configured.js";
import { MaybeCodeUsageError } from "./errors.js";
import { createNodeTerminal, type MaybeCodeTerminal } from "./terminal.js";
import { runTerminalUI } from "./tui.js";
import type { MaybeCodeController } from "./controller.js";

export interface RunMaybeCodeDependencies {
  readonly terminal?: MaybeCodeTerminal;
  readonly open?: (
    options: OpenConfiguredMaybeCodeOptions,
  ) => Promise<MaybeCodeController>;
}

export async function runMaybeCode(
  args: readonly string[],
  dependencies: RunMaybeCodeDependencies = {},
): Promise<number> {
  const terminal = dependencies.terminal ?? createNodeTerminal();
  let command;

  try {
    command = parseMaybeCodeArgs(args);
  } catch (error) {
    if (error instanceof MaybeCodeUsageError) {
      terminal.write(`Error: ${error.message}\n\n${MAYBE_CODE_USAGE}`);
      terminal.close();
      return 2;
    }
    terminal.close();
    throw error;
  }

  if (command.type === "help") {
    terminal.write(MAYBE_CODE_USAGE);
    terminal.close();
    return 0;
  }

  try {
    const open = dependencies.open ?? openConfiguredMaybeCode;
    const app = await open({
      ...(command.workspace === undefined
        ? {}
        : { workspace: command.workspace }),
      ...(command.configPath === undefined
        ? {}
        : { configPath: command.configPath }),
      ...(command.provider === undefined
        ? {}
        : { provider: command.provider }),
      ...(command.model === undefined ? {} : { model: command.model }),
      ...(command.sessionId === undefined
        ? {}
        : { sessionId: command.sessionId }),
      autoResume: command.autoResume,
    });
    await runTerminalUI(app, { terminal });
    return 0;
  } catch (error) {
    terminal.write(`\nError: ${errorMessage(error)}\n`);
    terminal.close();
    return 1;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
