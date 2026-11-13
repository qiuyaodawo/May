import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { UiCommand } from "@sortedyuan/ui-client";

export interface Command {
  object: string;
  action: string;
  value?: string;
  directory: string;
  config?: string;
  server?: string;
  passwordEnv?: string;
  session?: string;
  requestId?: string;
  port?: number;
  agents: string[];
  allowed: string[];
  identities: string[];
  name?: string;
  account?: string;
  conversation?: string;
  kind?: string;
  owner?: string;
  thread?: string;
  definition?: string;
  confirm?: boolean;
  noOpen?: boolean;
}

export async function uiCommand(command: Command, hostId: string): Promise<UiCommand> {
  const base: UiCommand = {
    version: 1,
    hostId,
    requestId: command.requestId ?? randomUUID(),
    targetId: command.session ?? null,
    name: "gateway.command",
    args: {},
  };
  if (command.object === "session") {
    if (command.action === "create")
      return {
        ...base,
        targetId: null,
        name: "session.create",
        args: {
          name: command.value!,
          agents: JSON.stringify(command.agents),
          allowed: JSON.stringify(command.allowed),
          ...(command.kind
            ? {
                entry: JSON.stringify({
                  kind: command.kind,
                  account: command.account,
                  conversation: command.conversation,
                  ...(command.owner ? { owner: command.owner } : {}),
                  ...(command.thread ? { threadId: command.thread } : {}),
                }),
              }
            : {}),
        },
      };
    return {
      ...base,
      targetId: command.value!,
      name: command.action === "select" ? "session.default" : `session.${command.action}`,
      args:
        command.action === "rename"
          ? { name: command.name! }
          : command.action === "admins"
            ? { admins: JSON.stringify(command.identities) }
            : command.action === "delete"
              ? { confirm: String(command.confirm === true) }
              : {},
    };
  }
  if (command.object === "agent") {
    if (command.action === "save")
      return {
        ...base,
        name: "agent.save",
        args: { id: command.value!, config: await readFile(resolve(command.definition!), "utf8") },
      };
    if (command.action === "check" || command.action === "delete")
      return {
        ...base,
        name: `agent.${command.action}`,
        args: {
          id: command.value!,
          ...(command.action === "delete" ? { confirm: String(command.confirm === true) } : {}),
        },
      };
    if (command.action === "default" || command.action === "allow")
      return {
        ...base,
        name: `agent.${command.action}`,
        args: { agents: JSON.stringify([command.value!, ...command.agents]) },
      };
    return { ...base, args: { text: `/agent create ${command.value}` } };
  }
  return {
    ...base,
    name: command.object === "task" ? "message.submit" : "gateway.command",
    args: {
      text:
        command.object === "task" && command.agents[0] ? `@${command.agents[0]} -- ${command.value}` : command.value!,
    },
  };
}

export function parse(args: readonly string[]): Command {
  const object = args[0] ?? "",
    action = object === "serve" ? "serve" : object === "command" ? "command" : (args[1] ?? "");
  const allowed: Record<string, readonly string[]> = {
    serve: ["serve"],
    session: ["create", "list", "show", "select", "archive", "restore", "delete", "rename", "admins"],
    agent: ["list", "check", "save", "delete", "create", "default", "allow"],
    task: ["submit", "list", "status", "result", "cancel", "run", "recover"],
    channel: ["status"],
    delivery: ["retry"],
    command: ["command"],
  };
  if (!allowed[object]?.includes(action)) throw new Error("Unknown Gateway command");
  const result: Command = {
    object,
    action,
    directory: join(homedir(), ".may", "maybeclaw"),
    agents: [],
    allowed: [],
    identities: [],
  };
  const single = new Set<string>();
  const options: Record<string, readonly string[]> = {
    "serve.serve": ["--port", "--no-open"],
    "session.create": [
      "--agent",
      "--allow-agent",
      "--kind",
      "--account",
      "--conversation",
      "--owner",
      "--thread",
      "--request-id",
    ],
    "session.rename": ["--name"],
    "session.admins": ["--identity"],
    "session.delete": ["--confirm"],
    "agent.save": ["--definition"],
    "agent.delete": ["--confirm"],
    "agent.create": ["--session", "--request-id"],
    "agent.default": ["--session", "--agent", "--request-id"],
    "agent.allow": ["--session", "--agent", "--request-id"],
    "task.submit": ["--session", "--agent", "--request-id"],
    "command.command": ["--session", "--request-id"],
    "delivery.retry": ["--confirm"],
  };
  const permitted = new Set([
    "--config",
    "--data-directory",
    "--server",
    "--password-env",
    ...(options[`${object}.${action}`] ?? []),
  ]);
  const names = {
    "--data-directory": "directory",
    "--config": "config",
    "--server": "server",
    "--password-env": "passwordEnv",
    "--session": "session",
    "--request-id": "requestId",
    "--name": "name",
    "--account": "account",
    "--conversation": "conversation",
    "--kind": "kind",
    "--owner": "owner",
    "--thread": "thread",
    "--definition": "definition",
  } as const;
  for (let index = object === "serve" || object === "command" ? 1 : 2; index < args.length; index++) {
    const flag = args[index]!;
    if (!flag.startsWith("--")) {
      if (result.value !== undefined) throw new Error("Quote the message or name as one argument");
      result.value = flag;
      continue;
    }
    if (!permitted.has(flag)) throw new Error(`Unsupported option for ${object} ${action}: ${flag}`);
    if (flag === "--no-open") {
      if (single.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      single.add(flag);
      result.noOpen = true;
      continue;
    }
    if (flag === "--confirm") {
      if (single.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      single.add(flag);
      result.confirm = true;
      continue;
    }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value: ${flag}`);
    if (["--agent", "--allow-agent", "--identity"].includes(flag)) {
      (flag === "--agent" ? result.agents : flag === "--allow-agent" ? result.allowed : result.identities).push(value);
      continue;
    }
    if (single.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    single.add(flag);
    if (flag === "--port") {
      result.port = Number(value);
      if (!Number.isSafeInteger(result.port) || result.port < 0 || result.port > 65535)
        throw new Error("--port must be 0..65535");
      continue;
    }
    if (!(flag in names))
      throw new Error(`Unsupported option: ${flag}. Model and directory options belong in Agent configuration.`);
    result[names[flag as keyof typeof names]] = value;
  }
  if (!["serve", "list", "status"].includes(action) && !result.value)
    throw new Error("A name, ID, or message is required");
  if (object === "task" && action !== "list" && !result.value) throw new Error("Task prompt or ID is required");
  if (object === "agent" && action !== "list" && !result.value) throw new Error("Agent ID is required");
  if ((["serve", "channel"].includes(object) || action === "list") && result.value !== undefined)
    throw new Error("This command does not accept a positional argument");
  if (object === "session" && action === "create" && !result.agents.length)
    throw new Error("Session creation requires --agent <id>");
  if (
    ((object === "task" && action === "submit") ||
      (object === "agent" && ["create", "default", "allow"].includes(action))) &&
    !result.session
  )
    throw new Error("This operation requires --session <id>. Create a session with session create first.");
  if (object === "agent" && action === "save" && !result.definition)
    throw new Error("agent save requires --definition <json-file>");
  if (object === "task" && action === "submit" && result.agents.length > 1)
    throw new Error("Use one --agent to target a single Agent, or omit it to use the session defaults");
  if (object === "delivery" && !result.server) throw new Error("delivery retry requires --server <url>");
  if (!result.server && result.passwordEnv) throw new Error("--password-env requires --server");
  if (object === "session" && action === "rename" && !result.name)
    throw new Error("session rename requires --name <name>");
  if (object === "serve" && result.server) throw new Error("This command requires direct access to the data directory");
  if (result.server && (result.config || single.has("--data-directory")))
    throw new Error("--server uses the server's configuration and data directory");
  if (
    result.kind &&
    (!["private", "group"].includes(result.kind) ||
      !result.account ||
      !result.conversation ||
      (result.kind === "private" && !result.owner))
  )
    throw new Error("Entry requires --kind private|group, --account, --conversation and --owner for a private chat");
  if (!result.kind && (result.account || result.conversation || result.owner || result.thread))
    throw new Error("Entry options require --kind");
  result.directory = resolve(result.directory);
  return result;
}
