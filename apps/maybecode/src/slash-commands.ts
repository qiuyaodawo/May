import { MCP_COMMAND_USAGE } from "./mcp-commands.js";
import { GOAL_COMMAND_USAGE } from "./goal-commands.js";
import { DELEGATION_COMMAND_USAGE } from "./delegation-commands.js";
import type { ContextCompactionResult, ContextInspection } from "@sortedyuan/may/context";
import type { SessionSummary } from "@sortedyuan/may/session/catalog";
import type { McpServerStatus } from "@sortedyuan/mcp";
import {
  SlashCommandRegistry,
  type SlashCommandDefinition,
  type SlashCommandInvocation,
  type SlashCommandParseResult,
  type SlashCommandSuggester,
  type SlashCommandSuggestion,
} from "@sortedyuan/tui/slash-commands";
import type {
  MaybeCodeCompactionStrategyName,
  MaybeCodeModelInfo,
  MaybeCodeModelProfile,
  MaybeCodeReasoningEffortState,
} from "./controller.js";
import type { MaybeCodeRun } from "./events.js";
import type { MaybeCodeInstructions } from "./instructions.js";
import type { UiForkPoint, UiWorkspaceDiff, UiWorktree } from "@sortedyuan/ui-client";

export type MaybeCodeSlashCommandName =
  | "/steer"
  | "/stop"
  | "/yolo"
  | "/permissions"
  | "/goal"
  | "/new"
  | "/resume"
  | "/fork"
  | "/changes"
  | "/worktrees"
  | "/model"
  | "/lsp"
  | "/effort"
  | "/retry"
  | "/recovery"
  | "/delegations"
  | "/skills"
  | "/instructions"
  | "/mcp"
  | "/status"
  | "/context"
  | "/compact"
  | "/web"
  | "/help"
  | "/quit";

export type MaybeCodeSlashCommand = SlashCommandDefinition<MaybeCodeSlashCommandName>;

export const MAYBECODE_COMPACTION_STRATEGIES = [
  "history-reference",
  "provider-native",
] as const satisfies readonly MaybeCodeCompactionStrategyName[];

export const MAYBECODE_SLASH_COMMANDS: readonly MaybeCodeSlashCommand[] = [
  { name: "/lsp", usage: "/lsp [restart <id>]", description: "Inspect or restart configured language servers" },
  {
    name: "/permissions",
    usage: "/permissions [list|allow <id>|deny <id>|revoke <id>]",
    description: "查看、创建或撤销持久权限规则",
  },
  {
    name: "/fork",
    usage: "/fork",
    description: "Choose a historical reply and fork in this workspace or a new worktree",
  },
  {
    name: "/changes",
    usage: "/changes [run <run-id>|session|workspace|commit <commit>]",
    description: "Browse checkpoint and workspace file changes",
  },
  { name: "/worktrees", usage: "/worktrees [open|delete <id>]", description: "List, open or delete managed worktrees" },
  {
    name: "/steer",
    usage: "/steer <message>",
    description: "Deliver additional input after the current Step finishes",
  },
  { name: "/stop", usage: "/stop", description: "Cancel the current operation" },
  {
    name: "/yolo",
    usage: "/yolo [on|off|status]",
    description: "Enable automatic tool approval; use off to disable or status to inspect",
  },
  { name: "/goal", usage: GOAL_COMMAND_USAGE, description: "Start, inspect, pause, resume, or cancel a durable goal" },
  { name: "/web", usage: "/web", description: "Open the current workspace and session in a browser" },
  {
    name: "/skills",
    usage: "/skills [show <name>|use <name> [task]]",
    description: "List skills, preview instructions, or activate a skill",
  },
  {
    name: "/recovery",
    usage: "/recovery [resolve <id> <verified finding>]",
    description: "Inspect interrupted tools or record verified recovery findings",
  },
  {
    name: "/delegations",
    usage: DELEGATION_COMMAND_USAGE,
    description: "Inspect sub-agent requests and tools, and control status notifications",
  },
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
    usage: "/compact [history-reference|provider-native]",
    description: "Prune and summarize context, reset with saved work notes, or compact natively",
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

export type MaybeCodeSlashCommandInvocation = SlashCommandInvocation<MaybeCodeSlashCommand>;

export type MaybeCodeSlashCommandParseResult = SlashCommandParseResult<MaybeCodeSlashCommand>;

export type MaybeCodeSlashCommandResult =
  | { readonly type: "fork.selection.requested"; readonly points: readonly UiForkPoint[] }
  | { readonly type: "changes.selection.requested"; readonly diff: UiWorkspaceDiff }
  | { readonly type: "worktrees.display"; readonly worktrees: readonly UiWorktree[] }
  | { readonly type: "web.requested" }
  | { readonly type: "skill.run-started"; readonly run: MaybeCodeRun }
  | { readonly type: "display"; readonly text: string }
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

export function formatMaybeCodeMcpStatus(servers: readonly McpServerStatus[]): string {
  if (servers.length === 0) return "MCP: disabled (no servers configured)";
  const lines = ["MCP servers:"];
  for (const server of servers) {
    const requirement = server.required ? "required" : "optional";
    lines.push(`- ${server.serverId}: ${server.state} (${requirement}, ${server.transport})`);
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
      const code = server.diagnostic.code === undefined ? "" : ` [${server.diagnostic.code}]`;
      lines.push(...indentLines(`  error${code}: `, server.diagnostic.message));
    }
    const stderr = server.stderr ?? server.diagnostic?.stderr;
    if (stderr !== undefined) {
      lines.push(...indentLines("  recent stderr: ", stderr));
    }
  }
  return lines.join("\n");
}

export const maybeCodeSlashCommands = new SlashCommandRegistry(MAYBECODE_SLASH_COMMANDS);

export function parseMaybeCodeSlashCommand(input: string): MaybeCodeSlashCommandParseResult {
  return maybeCodeSlashCommands.parse(input);
}

export function matchMaybeCodeSlashCommands(prefix: string): readonly MaybeCodeSlashCommandSuggestion[] {
  return maybeCodeSlashCommands.match(prefix);
}

export function reasoningEffortChoices(state: MaybeCodeReasoningEffortState): readonly string[] {
  return ["default", ...state.efforts];
}

export function reasoningEffortDescription(effort: string, state: MaybeCodeReasoningEffortState): string {
  if (effort === "default") {
    const value = state.defaultEffort ?? "provider/model default";
    return `Clear runtime override · ${value}`;
  }
  const current = effort === state.effectiveEffort ? "Current · " : "";
  return `${current}capability source: ${state.source}`;
}

export function usage(definition: MaybeCodeSlashCommand): Extract<MaybeCodeSlashCommandResult, { type: "usage" }> {
  return { type: "usage", usage: definition.usage };
}

export function isCompactionStrategy(value: string): value is MaybeCodeCompactionStrategyName {
  return MAYBECODE_COMPACTION_STRATEGIES.some((strategy) => strategy === value);
}

function indentLines(prefix: string, value: string): readonly string[] {
  const lines = value.split("\n");
  return lines.map((line, index) => (index === 0 ? `${prefix}${line}` : `    ${line}`));
}
