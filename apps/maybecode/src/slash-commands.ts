import type {
  ContextCompactionResult,
  ContextInspection,
} from "@may/context";
import type { SessionSummary } from "./catalog.js";
import type {
  MaybeCodeCompactionStrategyName,
  MaybeCodeController,
} from "./controller.js";
import type { MaybeCodeRun } from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";

export type MaybeCodeSlashCommandName =
  | "/new"
  | "/sessions"
  | "/resume"
  | "/retry"
  | "/instructions"
  | "/status"
  | "/context"
  | "/compact"
  | "/help"
  | "/quit";

export interface MaybeCodeSlashCommand {
  readonly name: MaybeCodeSlashCommandName;
  readonly aliases?: readonly string[];
  readonly usage: string;
  readonly description: string;
}

export const MAYBECODE_COMPACTION_STRATEGIES = [
  "prune-old-tool-results",
  "summary-tail",
  "history-reference",
] as const satisfies readonly MaybeCodeCompactionStrategyName[];

export const MAYBECODE_SLASH_COMMANDS: readonly MaybeCodeSlashCommand[] = [
  {
    name: "/new",
    usage: "/new",
    description: "Start a new session",
  },
  {
    name: "/sessions",
    usage: "/sessions",
    description: "List sessions for this workspace",
  },
  {
    name: "/resume",
    usage: "/resume <session-id>",
    description: "Switch to another session",
  },
  {
    name: "/retry",
    usage: "/retry",
    description: "Retry the latest failed run",
  },
  {
    name: "/instructions",
    usage: "/instructions",
    description: "Show active instruction sources and content",
  },
  {
    name: "/status",
    usage: "/status",
    description: "Show model, session, workspace, and context status",
  },
  {
    name: "/context",
    usage: "/context",
    description: "Show current context usage",
  },
  {
    name: "/compact",
    usage:
      "/compact [prune-old-tool-results|summary-tail|history-reference]",
    description: "Compact the active model context",
  },
  {
    name: "/help",
    usage: "/help",
    description: "Show commands",
  },
  {
    name: "/quit",
    aliases: ["/exit"],
    usage: "/quit",
    description: "Exit MaybeCode",
  },
];

export interface MaybeCodeSlashCommandInvocation {
  readonly type: "command";
  readonly definition: MaybeCodeSlashCommand;
  readonly invokedAs: string;
  readonly arguments: readonly string[];
}

export type MaybeCodeSlashCommandParseResult =
  | MaybeCodeSlashCommandInvocation
  | { readonly type: "not-command" }
  | { readonly type: "unknown"; readonly command: string };

export type MaybeCodeSlashCommandResult =
  | { readonly type: "exit" }
  | {
      readonly type: "help";
      readonly commands: readonly MaybeCodeSlashCommand[];
    }
  | {
      readonly type: "instructions";
      readonly instructions: MaybeCodeInstructions;
    }
  | { readonly type: "retry.started"; readonly run: MaybeCodeRun }
  | {
      readonly type: "status";
      readonly inspection: ContextInspection | undefined;
    }
  | {
      readonly type: "context";
      readonly inspection: ContextInspection | undefined;
    }
  | {
      readonly type: "compacted";
      readonly result: ContextCompactionResult;
    }
  | { readonly type: "session.created"; readonly sessionId: string }
  | {
      readonly type: "sessions";
      readonly sessions: readonly SessionSummary[];
    }
  | { readonly type: "session.resumed"; readonly sessionId: string }
  | { readonly type: "usage"; readonly usage: string }
  | { readonly type: "unknown"; readonly command: string };

export interface MaybeCodeSlashCommandSuggestion {
  /** Full input value represented by this suggestion. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export type MaybeCodeSlashCommandSuggester = (
  input: string,
) => Promise<readonly MaybeCodeSlashCommandSuggestion[]>;

export function parseMaybeCodeSlashCommand(
  input: string,
): MaybeCodeSlashCommandParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "not-command" };
  const [invokedAs = "", ...arguments_] = trimmed.split(/\s+/u);
  const definition = findCommand(invokedAs);
  return definition === undefined
    ? { type: "unknown", command: invokedAs }
    : {
        type: "command",
        definition,
        invokedAs,
        arguments: arguments_,
      };
}

export function matchMaybeCodeSlashCommands(
  prefix: string,
): readonly MaybeCodeSlashCommandSuggestion[] {
  if (!prefix.startsWith("/") || /\s/u.test(prefix)) return [];
  const normalized = prefix.toLowerCase();
  return commandNames()
    .filter(({ value }) => value.startsWith(normalized))
    .map(({ value, definition }) => ({
      value,
      label: value,
      description: definition.description,
    }));
}

export function createMaybeCodeSlashCommandSuggester(
  controller: MaybeCodeController,
  options: { readonly sessionCacheMs?: number } = {},
): MaybeCodeSlashCommandSuggester {
  const sessionCacheMs = options.sessionCacheMs ?? 1_000;
  if (!Number.isFinite(sessionCacheMs) || sessionCacheMs < 0) {
    throw new RangeError("sessionCacheMs must be a non-negative finite number");
  }
  let cachedSessions: readonly SessionSummary[] | undefined;
  let cachedAt = 0;

  const sessions = async (): Promise<readonly SessionSummary[]> => {
    const now = Date.now();
    if (
      cachedSessions === undefined ||
      now - cachedAt >= sessionCacheMs
    ) {
      cachedSessions = await controller.listSessions();
      cachedAt = Date.now();
    }
    return cachedSessions;
  };

  return async (input) => {
    if (!input.startsWith("/")) return [];
    const argumentInput = splitArgumentInput(input);
    if (argumentInput === undefined) {
      return matchMaybeCodeSlashCommands(input);
    }

    const definition = findCommand(argumentInput.command);
    if (definition?.name === "/compact") {
      if (/\s/u.test(argumentInput.argumentPrefix)) return [];
      return MAYBECODE_COMPACTION_STRATEGIES
        .filter((strategy) => strategy.startsWith(argumentInput.argumentPrefix))
        .map((strategy) => ({
          value: `${argumentInput.command} ${strategy}`,
          label: strategy,
          description: "Context compaction strategy",
        }));
    }

    if (definition?.name === "/resume") {
      if (/\s/u.test(argumentInput.argumentPrefix)) return [];
      return (await sessions())
        .filter((session) => session.id.startsWith(argumentInput.argumentPrefix))
        .map((session) => ({
          value: `${argumentInput.command} ${session.id}`,
          label: session.id,
          description: session.id === controller.sessionId
            ? "Current session"
            : `Last used ${new Date(session.lastUsedAt).toISOString()}`,
        }));
    }

    return [];
  };
}

export async function executeMaybeCodeSlashCommand(
  input: string,
  controller: MaybeCodeController,
): Promise<MaybeCodeSlashCommandResult> {
  const parsed = parseMaybeCodeSlashCommand(input);
  if (parsed.type !== "command") {
    return parsed.type === "unknown"
      ? parsed
      : { type: "unknown", command: input };
  }

  const { definition, arguments: arguments_ } = parsed;
  switch (definition.name) {
    case "/quit":
      return noArguments(arguments_, definition) ?? { type: "exit" };
    case "/help":
      return noArguments(arguments_, definition) ?? {
        type: "help",
        commands: MAYBECODE_SLASH_COMMANDS,
      };
    case "/instructions":
      return noArguments(arguments_, definition) ?? {
        type: "instructions",
        instructions: controller.instructions,
      };
    case "/retry": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "retry.started", run: await controller.retry() };
    }
    case "/status": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "status", inspection: await controller.inspectContext() };
    }
    case "/context": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "context", inspection: await controller.inspectContext() };
    }
    case "/compact": {
      const strategy = arguments_[0];
      if (
        arguments_.length > 1 ||
        (strategy !== undefined && !isCompactionStrategy(strategy))
      ) {
        return usage(definition);
      }
      return {
        type: "compacted",
        result: await controller.compactContext(strategy),
      };
    }
    case "/new": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "session.created", sessionId: await controller.newSession() };
    }
    case "/sessions": {
      const invalid = noArguments(arguments_, definition);
      if (invalid !== undefined) return invalid;
      return { type: "sessions", sessions: await controller.listSessions() };
    }
    case "/resume": {
      const sessionId = arguments_[0];
      if (arguments_.length !== 1 || sessionId === undefined) {
        return usage(definition);
      }
      await controller.resumeSession(sessionId);
      return { type: "session.resumed", sessionId };
    }
  }
}

function commandNames(): Array<{
  value: string;
  definition: MaybeCodeSlashCommand;
}> {
  return MAYBECODE_SLASH_COMMANDS.flatMap((definition) => [
    { value: definition.name, definition },
    ...(definition.aliases ?? []).map((value) => ({ value, definition })),
  ]);
}

function findCommand(name: string): MaybeCodeSlashCommand | undefined {
  const normalized = name.toLowerCase();
  return MAYBECODE_SLASH_COMMANDS.find((definition) =>
    definition.name === normalized ||
    definition.aliases?.includes(normalized) === true
  );
}

function splitArgumentInput(input: string): {
  command: string;
  argumentPrefix: string;
} | undefined {
  const match = /^(\/\S+)\s+(.*)$/u.exec(input);
  if (match === null) return undefined;
  return { command: match[1]!, argumentPrefix: match[2]! };
}

function noArguments(
  arguments_: readonly string[],
  definition: MaybeCodeSlashCommand,
): Extract<MaybeCodeSlashCommandResult, { type: "usage" }> | undefined {
  return arguments_.length === 0 ? undefined : usage(definition);
}

function usage(
  definition: MaybeCodeSlashCommand,
): Extract<MaybeCodeSlashCommandResult, { type: "usage" }> {
  return { type: "usage", usage: definition.usage };
}

function isCompactionStrategy(
  value: string,
): value is MaybeCodeCompactionStrategyName {
  return MAYBECODE_COMPACTION_STRATEGIES.some((strategy) => strategy === value);
}
