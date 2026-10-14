import {
  MAYBE_CODE_USAGE,
  parseMaybeCodeArgs,
} from "./args.js";
import type { OpenConfiguredMaybeCodeOptions } from "./configured.js";
import { MaybeCodeUsageError } from "./errors.js";
import { createNodeTerminal, type TerminalIO } from "@may/tui/node-terminal";
import type { MaybeCodeController } from "./controller.js";
import type { runMaybeCodeMcpCommand } from "./mcp-auth.js";
import type { runMaybeCodeTeamCommand } from "./team.js";
import type { runMaybeCodeWebUI } from "./web-ui.js";

export interface RunMaybeCodeDependencies {
  readonly terminal?: TerminalIO;
  readonly open?: (
    options: OpenConfiguredMaybeCodeOptions,
  ) => Promise<MaybeCodeController>;
  readonly runRetainedUI?: (app: MaybeCodeController) => Promise<void>;
  readonly mcpAuth?: typeof runMaybeCodeMcpCommand;
  readonly team?: typeof runMaybeCodeTeamCommand;
  readonly runWebUI?: typeof runMaybeCodeWebUI;
}

export async function runMaybeCode(
  args: readonly string[],
  dependencies: RunMaybeCodeDependencies = {},
): Promise<number> {
  let terminal = dependencies.terminal;
  const outputTerminal = (): TerminalIO => {
    terminal ??= createNodeTerminal();
    return terminal;
  };
  let command;

  try {
    command = parseMaybeCodeArgs(args);
  } catch (error) {
    if (error instanceof MaybeCodeUsageError) {
      outputTerminal().write(`Error: ${error.message}\n\n${MAYBE_CODE_USAGE}`);
      outputTerminal().close();
      return 2;
    }
    terminal?.close();
    throw error;
  }

  if (command.type === "help") {
    outputTerminal().write(MAYBE_CODE_USAGE);
    outputTerminal().close();
    return 0;
  }

  try {
    if (command.type === "team") {
      const cancellation = new AbortController();
      const interrupt = () => cancellation.abort(new Error("Team cancelled by user"));
      process.once("SIGINT", interrupt);
      try {
        const team = dependencies.team ?? (await import("./team.js")).runMaybeCodeTeamCommand;
        return await team(command, {
          write: (text) => outputTerminal().write(text), signal: cancellation.signal,
        });
      } finally {
        process.removeListener("SIGINT", interrupt);
        outputTerminal().close();
      }
    }
    if (command.type === "mcp") {
      const cancellation = new AbortController();
      const interrupt = () => cancellation.abort(new Error("MCP authentication cancelled"));
      process.once("SIGINT", interrupt);
      try {
        const mcpAuth = dependencies.mcpAuth ?? (await import("./mcp-auth.js")).runMaybeCodeMcpCommand;
        await mcpAuth(command, {
          write: (text) => outputTerminal().write(text), signal: cancellation.signal,
        });
      } finally {
        process.removeListener("SIGINT", interrupt);
      }
      outputTerminal().close();
      return 0;
    }
    const open = dependencies.open ?? (await import("./configured.js")).openConfiguredMaybeCode;
    const runWebUI = command.ui === "web"
      ? dependencies.runWebUI ?? (await import("./web-ui.js")).runMaybeCodeWebUI : undefined;
    const runRetainedUI = command.ui === "retained"
      ? dependencies.runRetainedUI ?? (await import("./ui/retained-tui.js")).runRetainedTerminalUI : undefined;
    const runClassicUI = command.ui === "classic" ? (await import("./tui.js")).runTerminalUI : undefined;
    const app = await open({
      ...(command.permissionMode === undefined ? {} : { permissionMode: command.permissionMode }),
      mcpInteractions: true,
      ...(command.workspace === undefined
        ? {}
        : { workspace: command.workspace }),
      ...(command.configPath === undefined
        ? {}
        : { configPath: command.configPath }),
      ...(command.model === undefined ? {} : { model: command.model }),
      ...(command.sessionId === undefined
        ? {}
        : { sessionId: command.sessionId }),
      autoResume: command.autoResume,
    });
    if (command.ui === "web") {
      await runWebUI!(app, { ...(command.port === undefined ? {} : { port: command.port }), write: text => outputTerminal().write(text) });
      terminal?.close();
    } else if (command.ui === "retained") {
      terminal?.close();
      await runRetainedUI!(app);
    } else {
      await runClassicUI!(app, { terminal: outputTerminal() });
    }
    return 0;
  } catch (error) {
    outputTerminal().write(`\nError: ${errorMessage(error)}\n`);
    outputTerminal().close();
    return 1;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "Unknown error";
}
