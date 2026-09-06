import { executeMcpCommand, MCP_COMMAND_USAGE } from "./mcp-commands.js";
import type {
  ContextCompactionResult,
  ContextInspection,
} from "@may/context";
import type { SessionSummary } from "@may/session/catalog";
import type { McpServerStatus } from "@may/mcp";
import {
  SlashCommandRegistry,
  type SlashCommandDefinition,
  type SlashCommandInvocation,
  type SlashCommandParseResult,
  type SlashCommandSuggester,
  type SlashCommandSuggestion,
} from "@may/tui/slash-commands";
import type {
  MaybeCodeCompactionStrategyName,
  MaybeCodeController,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import type { MaybeCodeRun } from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";

export type MaybeCodeSlashCommandName =
  | "/new"
  | "/resume"
  | "/model"
  | "/effort"
  | "/retry"
  | "/instructions"
  | "/mcp"
  | "/status"
  | "/context"
  | "/compact"
  | "/help"
  | "/quit";

export type MaybeCodeSlashCommand =
  SlashCommandDefinition<MaybeCodeSlashCommandName>;

export const MAYBECODE_COMPACTION_STRATEGIES = [
  "history-reference",
] as const satisfies readonly MaybeCodeCompactionStrategyName[];

export const MAYBECODE_SLASH_COMMANDS: readonly MaybeCodeSlashCommand[] = [
  {
    name: "/new",
    usage: "/new",
    description: "Start a new session",
  },
  {
    name: "/resume",
    usage: "/resume [session-id]",
    description: "Browse sessions or switch directly by ID",
  },
  {
    name: "/model",
    usage: "/model [profile-prefix [--default]]",
    description: "Browse, switch, or choose the default model profile",
  },
  {
    name: "/effort",
    usage: "/effort [default|level-prefix]",
    description: "Browse or change reasoning effort for the active model",
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
    name: "/mcp",
    usage: MCP_COMMAND_USAGE,
    description: "Show configured MCP servers, tools, and diagnostics",
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
    usage: "/compact [history-reference]",
    description: "Summarize context or replace older history with a reference",
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

export type MaybeCodeSlashCommandInvocation =
  SlashCommandInvocation<MaybeCodeSlashCommand>;

export type MaybeCodeSlashCommandParseResult =
  SlashCommandParseResult<MaybeCodeSlashCommand>;

export type MaybeCodeSlashCommandResult =
  | { readonly type: "mcp.display"; readonly text: string }
  | { readonly type: "mcp.run-started"; readonly run: MaybeCodeRun }
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
      readonly type: "mcp.status";
      readonly servers: readonly McpServerStatus[];
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
      readonly type: "session.selection.requested";
      readonly sessions: readonly SessionSummary[];
    }
  | { readonly type: "session.resumed"; readonly sessionId: string }
  | {
      readonly type: "model.selection.requested";
      readonly models: readonly MaybeCodeModelProfile[];
    }
  | {
      readonly type: "model.switched";
      readonly profile: string;
      readonly model: MaybeCodeModelInfo;
    }
  | { readonly type: "model.not-found"; readonly query: string }
  | {
      readonly type: "effort.selection.requested";
      readonly state: MaybeCodeReasoningEffortState;
    }
  | {
      readonly type: "effort.changed";
      readonly state: MaybeCodeReasoningEffortState;
    }
  | { readonly type: "effort.not-found"; readonly query: string }
  | { readonly type: "usage"; readonly usage: string }
  | { readonly type: "unknown"; readonly command: string };

export type MaybeCodeSlashCommandSuggestion = SlashCommandSuggestion;

export type MaybeCodeSlashCommandSuggester = SlashCommandSuggester;

export function formatMaybeCodeMcpStatus(
  servers: readonly McpServerStatus[],
): string {
  if (servers.length === 0) return "MCP: disabled (no servers configured)";
  const lines = ["MCP servers:"];
  for (const server of servers) {
    const requirement = server.required ? "required" : "optional";
    lines.push(
      `- ${server.serverId}: ${server.state} (${requirement}, ${server.transport})`,
    );
    if (server.protocolVersion !== undefined) {
      lines.push(`  protocol: ${server.protocolVersion}`);
    }
    if (server.catalogRevision !== undefined) {
      lines.push(`  catalog: ${server.catalogRevision}${server.catalogStale ? " (stale)" : ""}`);
    }
    if (server.catalogSubscription !== undefined) lines.push(`  catalog notifications: ${server.catalogSubscription}`);
    if (server.toolNames.length > 0) {
      lines.push(`  tools (${server.toolNames.length}):`);
      lines.push(...server.toolNames.map((name) => `    - ${name}`));
    }
    if (server.diagnostic !== undefined) {
      const code = server.diagnostic.code === undefined
        ? ""
        : ` [${server.diagnostic.code}]`;
      lines.push(
        ...indentLines(
          `  error${code}: `,
          server.diagnostic.message,
        ),
      );
    }
    const stderr = server.stderr ?? server.diagnostic?.stderr;
    if (stderr !== undefined) {
      lines.push(...indentLines("  recent stderr: ", stderr));
    }
  }
  return lines.join("\n");
}

const maybeCodeSlashCommands = new SlashCommandRegistry(MAYBECODE_SLASH_COMMANDS);

export function parseMaybeCodeSlashCommand(
  input: string,
): MaybeCodeSlashCommandParseResult {
  return maybeCodeSlashCommands.parse(input);
}

export function matchMaybeCodeSlashCommands(
  prefix: string,
): readonly MaybeCodeSlashCommandSuggestion[] {
  return maybeCodeSlashCommands.match(prefix);
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

  return maybeCodeSlashCommands.createSuggester(async (argumentInput) => {
    const { definition, invokedAs: command, argumentPrefix } = argumentInput;
    if (definition?.name === "/compact") {
      if (/\s/u.test(argumentPrefix)) return [];
      return MAYBECODE_COMPACTION_STRATEGIES
        .filter((strategy) => strategy.startsWith(argumentPrefix))
        .map((strategy) => ({
          value: `${command} ${strategy}`,
          label: strategy,
          description: "Keep the current turn and reference durable history",
        }));
    }

    if (definition?.name === "/resume") {
      if (/\s/u.test(argumentPrefix)) return [];
      return (await sessions())
        .filter((session) => session.id.startsWith(argumentPrefix))
        .map((session) => ({
          value: `${command} ${session.id}`,
          label: session.id,
          description: session.id === controller.sessionId
            ? "Current session"
            : `Last used ${new Date(session.lastUsedAt).toISOString()}`,
        }));
    }

    if (definition?.name === "/model") {
      const optionInput = /^(\S+)\s+(\S*)$/u.exec(
        argumentPrefix,
      );
      if (optionInput !== null) {
        const optionPrefix = optionInput[2]!;
        return "--default".startsWith(optionPrefix)
          ? [{
              value: `${command} ${optionInput[1]} --default`,
              label: "--default",
              description: "Switch to this profile and make it the default",
            }]
          : [];
      }
      if (/\s/u.test(argumentPrefix)) return [];
      const normalized = argumentPrefix.toLowerCase();
      return (await controller.listModels())
        .filter((model) => model.name.toLowerCase().startsWith(normalized))
        .map((model) => ({
          value: `${command} ${model.name}`,
          label: model.name,
          description: model.name === controller.modelInfo?.profile
            ? `Current · ${model.provider}/${model.model}`
            : `${model.provider}/${model.model} · ${model.adapter}`,
        }));
    }

    if (definition?.name === "/effort") {
      if (/\s/u.test(argumentPrefix)) return [];
      const state = await controller.getReasoningEffort();
      if (state.status !== "known") return [];
      const normalized = argumentPrefix.toLowerCase();
      return reasoningEffortChoices(state)
        .filter((effort) => effort.toLowerCase().startsWith(normalized))
        .map((effort) => ({
          value: `${command} ${effort}`,
          label: effort,
          description: reasoningEffortDescription(effort, state),
        }));
    }

    return [];
  });
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
    case "/mcp": return executeMcpCommand(input, controller);
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
    case "/resume": {
      const sessionId = arguments_[0];
      if (arguments_.length === 0) {
        return {
          type: "session.selection.requested",
          sessions: await controller.listSessions(),
        };
      }
      if (arguments_.length !== 1 || sessionId === undefined) {
        return usage(definition);
      }
      await controller.resumeSession(sessionId);
      return { type: "session.resumed", sessionId };
    }
    case "/model": {
      if (arguments_.length === 0) {
        return {
          type: "model.selection.requested",
          models: await controller.listModels(),
        };
      }
      const query = arguments_[0];
      const setDefault = arguments_[1] === "--default";
      if (
        query === undefined ||
        arguments_.length > 2 ||
        (arguments_.length === 2 && !setDefault)
      ) {
        return usage(definition);
      }
      const normalized = query.toLowerCase();
      const selected = (await controller.listModels()).find((model) =>
        model.name.toLowerCase().startsWith(normalized)
      );
      if (selected === undefined) return { type: "model.not-found", query };
      const model = await controller.switchModel(selected.name);
      if (setDefault) await controller.setDefaultModel(selected.name);
      return {
        type: "model.switched",
        profile: selected.name,
        model,
      };
    }
    case "/effort": {
      const state = await controller.getReasoningEffort();
      if (arguments_.length === 0) {
        return { type: "effort.selection.requested", state };
      }
      const query = arguments_[0];
      if (arguments_.length !== 1 || query === undefined) {
        return usage(definition);
      }
      if (state.status !== "known") {
        return { type: "effort.selection.requested", state };
      }
      const normalized = query.toLowerCase();
      const selected = reasoningEffortChoices(state).find((effort) =>
        effort.toLowerCase().startsWith(normalized)
      );
      if (selected === undefined) return { type: "effort.not-found", query };
      return {
        type: "effort.changed",
        state: await controller.setReasoningEffort(
          selected === "default" ? undefined : selected,
        ),
      };
    }
  }
}

function reasoningEffortChoices(
  state: MaybeCodeReasoningEffortState,
): readonly string[] {
  return ["default", ...state.efforts];
}

function reasoningEffortDescription(
  effort: string,
  state: MaybeCodeReasoningEffortState,
): string {
  if (effort === "default") {
    const value = state.defaultEffort ?? "provider/model default";
    return `Clear runtime override · ${value}`;
  }
  const current = effort === state.effectiveEffort ? "Current · " : "";
  return `${current}capability source: ${state.source}`;
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

function indentLines(prefix: string, value: string): readonly string[] {
  const lines = value.split("\n");
  return lines.map((line, index) =>
    index === 0 ? `${prefix}${line}` : `    ${line}`
  );
}
