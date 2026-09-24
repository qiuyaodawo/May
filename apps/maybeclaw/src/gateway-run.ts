import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import open from "open";
import { getDefaultMayConfigPath, loadMayConfig } from "@may/config";
import type { Server } from "node:http";
import { inspectGatewaySetup, startGatewaySetup } from "./gateway-setup.js";
import type { UiCommand } from "@may/ui-client";
import { AgentGateway } from "./gateway.js";
import { GatewayHost } from "./gateway-host.js";
import { gatewaySettings } from "./gateway-settings.js";
import { checkLegacy, migrateLegacy } from "./gateway-migration.js";
import { GatewayUiHost, controlActor } from "./gateway-ui.js";
import { startGatewayServer } from "./gateway-server.js";
import { hostSettings, channelSecret } from "./settings.js";
import { TelegramAdapter, FeishuAdapter, type ChannelAdapter } from "./channels.js";
import type { GatewayApproval, GatewayTask } from "./gateway-types.js";
import type { MaybeClawDependencies } from "./run.js";

export const GATEWAY_USAGE = `MaybeClaw — Agent Gateway

maybeclaw [--config <path>] [--port <number>] [--no-open]
maybeclaw serve [--config <path>] [--port <number>]
maybeclaw session create <name> --agent <id> [--agent <id>] [--allow-agent <id>]
    [--kind private|group --account <id> --conversation <id> --owner <user-id> --thread <id>]
maybeclaw session list|show|select|archive|restore|delete [id] [--confirm]
maybeclaw session rename <id> --name <name>
maybeclaw session admins <id> --identity <platform-user-key> [--identity <key>]
maybeclaw agent list|check|create|delete [id] [--session <id>] [--confirm]
maybeclaw agent save <id> --definition <json-file>
maybeclaw agent default|allow <id> [--agent <id>] --session <id>
maybeclaw task submit <prompt> --session <id> [--agent <id>] [--request-id <id>]
maybeclaw task list|status|result|cancel|run|recover [id]
maybeclaw channel status
maybeclaw delivery retry|retry-legacy <id> [--confirm] --server <url>
maybeclaw command <slash-command> [--session <id>]
maybeclaw migrate check|run

Common options: --config <path>, --data-directory <path> (default ~/.may/maybeclaw).
With no subcommand, start the Web console and open the default browser.
Missing configuration or administrator authentication opens local password setup.
With --no-open, open the initialization file printed by the service on this machine.
Use --no-open or serve to start only the service. Ctrl+C stops the service.
Use --server http://127.0.0.1:<port> to manage a running service. The client uses
MAYBECLAW_ADMIN_PASSWORD or --password-env. Local task submit waits for completion;
server submissions return once accepted. Serve continues work after clients leave.
Agent model, directory, and startup options belong in version: 2 Agent configuration.
Exit codes: 0 completed/accepted/query; 1 operation failed; 2 invalid command.
`;

interface Command {
  object: string; action: string; value?: string; directory: string; config?: string; server?: string; passwordEnv?: string;
  session?: string; requestId?: string; port?: number; agents: string[]; allowed: string[]; identities: string[]; name?: string;
  account?: string; conversation?: string; kind?: string; owner?: string; thread?: string; definition?: string; confirm?: boolean;
  noOpen?: boolean;
}

async function runGatewayService(command: Command, deps: MaybeClawDependencies, launch: { openBrowser?: boolean }): Promise<number> {
  if (!deps.signal) throw new Error("serve requires an AbortSignal");
  if (deps.signal.aborted) return 0;
  const signal = deps.signal, path = resolve(command.config ?? getDefaultMayConfigPath());
  const print = (value: unknown) => (deps.stdout ?? process.stdout).write(`${JSON.stringify(value, null, 2)}\n`);
  const legacy = await checkLegacy(command.directory);
  if (legacy.hasLegacy && !legacy.migrated) throw new Error("已有任务数据需要迁移，请执行 pnpm maybeclaw migrate check 和 pnpm maybeclaw migrate run。");
  let gateway: AgentGateway | undefined, host: GatewayHost | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined, setup: Awaited<ReturnType<typeof startGatewaySetup>> | undefined;
  let stopped!: () => void;
  const aborted = new Promise<void>(resolve => { stopped = resolve; signal.addEventListener("abort", stopped, { once: true }); });
  async function activate(listener?: Server) {
    const config = await (deps.loadConfig ?? loadMayConfig)({ path });
    gateway = new AgentGateway({ directory: command.directory, configPath: config.path, settings: gatewaySettings(config) });
    const channels = hostSettings(config), adapters: ChannelAdapter[] = [];
    if (channels.telegram?.enabled) adapters.push(new TelegramAdapter(channels.telegram, channelSecret(channels.telegram.botToken, channels.telegram.botTokenEnv)));
    if (channels.feishu?.enabled) adapters.push(new FeishuAdapter(channels.feishu, channelSecret(channels.feishu.appSecret, channels.feishu.appSecretEnv)));
    host = await GatewayHost.start({ gateway, adapters });
    server = await startGatewayServer({ gateway, ...(listener ? { server: listener } : {}), ...(command.port === undefined ? {} : { port: command.port }), status: () => host!.status(), close: () => host!.close(), retryLegacyDelivery: (id, confirmUnknown) => host!.retryLegacyDelivery(id, controlActor, confirmUnknown) });
    print({ url: server.url, ...(server.publicUrl ? { publicUrl: server.publicUrl } : {}), directory: command.directory, channels: host.status().channels });
  }
  try {
    if ((await inspectGatewaySetup(path)).needsSetup) {
      setup = await startGatewaySetup({ path, ...(command.port === undefined ? {} : { port: command.port }), activate });
      print({ initialization: true, initializationFile: setup.launchPath, message: "请在本机浏览器打开初始化文件，设置管理员密码。" });
      if (launch.openBrowser && !command.noOpen && !signal.aborted) await open(setup.url);
      if (!signal.aborted) await Promise.race([setup.completed, aborted]);
    } else {
      await activate();
      if (launch.openBrowser && !command.noOpen && !signal.aborted) await open(server!.url);
    }
    if (!signal.aborted) await aborted;
    return 0;
  } finally {
    signal.removeEventListener("abort", stopped);
    await setup?.close();
    if (server) await server.close(); else if (host) await host.close(); else await gateway?.close();
  }
}

export function handlesGatewayCommand(args: readonly string[]): boolean {
  if (["serve", "session", "agent", "channel", "delivery", "command", "migrate"].includes(args[0] ?? "")) return true;
  if (args[0] !== "task") return false;
  if (["submit", "run"].includes(args[1] ?? "") || args.includes("--server") || args.includes("--session")) return true;
  const index = args.indexOf("--data-directory");
  return existsSync(join(index >= 0 ? args[index + 1] ?? "" : join(homedir(), ".may", "maybeclaw"), "gateway.sqlite"));
}

export async function runGatewayCommand(args: readonly string[], deps: MaybeClawDependencies, launch: { openBrowser?: boolean } = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout, err = deps.stderr ?? process.stderr;
  const print = (value: unknown) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  let command: Command;
  try { command = parse(args); }
  catch (error) { err.write(`${error instanceof Error ? error.message : "Invalid command"}\n${GATEWAY_USAGE}`); return 2; }
  try {
    if (command.object === "migrate") { print(command.action === "check" ? await checkLegacy(command.directory) : await migrateLegacy(command.directory)); return 0; }
    if (command.server) { print(await remote(command)); return 0; }
    if (command.object === "serve") return await runGatewayService(command, deps, launch);
    const config = await (deps.loadConfig ?? loadMayConfig)(command.config ? { path: command.config } : {});
    const legacy = await checkLegacy(command.directory);
    if (legacy.hasLegacy && !legacy.migrated) throw new Error("Existing task data requires explicit migration: maybeclaw migrate check, then maybeclaw migrate run");
    const settings = gatewaySettings(config), gateway = new AgentGateway({ directory: command.directory, configPath: config.path, settings });
    const ui = new GatewayUiHost(gateway);
    try {
      if (command.object === "session" && command.action === "list") { print(gateway.sessions(controlActor)); return 0; }
      if (command.object === "session" && command.action === "show") { print(gateway.session(command.value!, controlActor)); return 0; }
      if (command.object === "agent" && command.action === "list") { print(gateway.status().agents); return 0; }
      if (command.object === "channel") { print({ configuredEntries: gateway.sessions(controlActor).filter(session => session.entry).map(session => ({ sessionId: session.id, entry: session.entry })), gateway: gateway.status() }); return 0; }
      if (command.object === "task" && command.action !== "submit") {
        if (command.action === "list") { print({ tasks: gateway.store.list("tasks"), legacy: gateway.store.list("legacy-tasks") }); return 0; }
        const task = gateway.store.get<GatewayTask>("tasks", command.value!);
        if (!task) { const legacyTask = gateway.store.get("legacy-tasks", command.value!); if (legacyTask && ["status", "result"].includes(command.action)) { print({ legacy: legacyTask }); return 0; } throw new Error("Task not found or legacy work requires explicit assignment to a session"); }
        if (command.action === "cancel") await gateway.stop(gateway.session(task.sessionId, controlActor), controlActor, undefined, task.id);
        else if (command.action === "run") {
          await gateway.dispatchTask(task.id, controlActor);
          const tasks = await waitForTasks(gateway, [task.id], deps); print(tasks);
          return tasks.some(item => item.status !== "completed") ? 1 : 0;
        }
        else if (command.action === "recover") await gateway.recoverTask(task.id, controlActor);
        const current = gateway.store.get<GatewayTask>("tasks", task.id)!;
        if (command.action === "result" && current.status !== "completed") throw new Error(`Result unavailable: ${current.status}`);
        print(current); return 0;
      }
      if (command.object === "task" && command.action === "submit") {
        const receipt = await gateway.handle(command.agents[0] ? `@${command.agents[0]} -- ${command.value}` : command.value!, controlActor,
          { requestId: `cli:${command.requestId ?? randomUUID()}`, sessionId: command.session! });
        print(receipt);
        const tasks = await waitForTasks(gateway, receipt.taskIds ?? [], deps);
        print(tasks); return tasks.some(task => task.status !== "completed") ? 1 : 0;
      }
      const request = await uiCommand(command, ui.hostId);
      const result = await ui.execute(request); print(result);
      return 0;
    } finally { ui.close(); await gateway.close(); }
  } catch (error) { err.write(`${JSON.stringify(error instanceof Error ? error.message : "Gateway operation failed")}\n`); return 1; }
}

async function waitForTasks(gateway: AgentGateway, taskIds: readonly string[], deps: MaybeClawDependencies): Promise<GatewayTask[]> {
  const graphIds = new Set(taskIds.map(id => gateway.store.get<GatewayTask>("tasks", id)?.graphId));
  const current = () => gateway.store.list<GatewayTask>("tasks").filter(task => graphIds.has(task.graphId));
  let tasks = current();
  while (tasks.some(task => ["queued", "running", "waiting", "cancelling"].includes(task.status))) {
    if (deps.signal?.aborted) {
      for (const id of taskIds) {
        const task = gateway.store.get<GatewayTask>("tasks", id)!;
        await gateway.stop(gateway.session(task.sessionId, controlActor), controlActor, undefined, id);
      }
      return current();
    }
    const approval = gateway.store.list<GatewayApproval>("approvals").find(item => item.status === "pending" && tasks.some(task => task.id === item.taskId));
    if (approval) {
      if (!process.stdin.isTTY) {
        await gateway.resolveApproval(approval.id, controlActor, "deny");
        throw new Error("Foreground work requires approval. Use serve and task submit --server for commands without an interactive terminal.");
      }
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await reader.question(`${approval.text}\nallow${approval.grantKey ? "/allow-session" : ""}/deny: `, deps.signal ? { signal: deps.signal } : {});
        if (!["allow", "deny", ...(approval.grantKey ? ["allow-session"] : [])].includes(answer)) throw new Error("Invalid approval decision");
        await gateway.resolveApproval(approval.id, controlActor, answer as "allow" | "allow-session" | "deny");
      } finally { reader.close(); }
    }
    await gateway.maintain(); await delay(100); tasks = current();
  }
  return tasks;
}

async function remote(command: Command): Promise<unknown> {
  const url = new URL(command.server!);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--server must be a loopback http://127.0.0.1:<port> URL");
  const passwordName = command.passwordEnv ?? "MAYBECLAW_ADMIN_PASSWORD";
  const password = process.env[passwordName];
  if (password === undefined) throw new Error(`Set administrator password environment variable ${passwordName}`);
  const login = await fetch(new URL("/api/auth/login", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }), redirect: "error", signal: AbortSignal.timeout(30_000) });
  const credentials = await login.json() as { token?: string; error?: string };
  if (!login.ok || !credentials.token) throw new Error(credentials.error ?? "Gateway login failed");
  const token = credentials.token;
  const request = async (path: string, data?: unknown) => {
    const response = await fetch(new URL(path, url), { method: data === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "content-type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    const result: unknown = await response.json();
    if (!response.ok) throw new Error((result as { error?: string }).error ?? "Gateway request failed"); return result;
  };
  try { return await executeRemote(); }
  finally { await request("/api/auth/logout", {}); }
  async function executeRemote(): Promise<unknown> {
  if (command.object === "session" && command.action === "list") return request("/api/v2/sessions");
  if (command.object === "session" && command.action === "show") return request(`/api/v2/sessions/${encodeURIComponent(command.value!)}`);
  if (command.object === "agent" && command.action === "list") return request("/api/v2/agents");
  if (command.object === "channel") return request("/api/v2/health");
  if (command.object === "delivery") return request(`/api/v2/${command.action === "retry-legacy" ? "legacy-deliveries" : "deliveries"}/${encodeURIComponent(command.value!)}/retry`, { confirmUnknown: command.confirm === true });
  if (command.object === "task") {
    if (command.action === "list") return request("/api/v2/tasks");
    if (command.action === "submit") return request("/api/v2/tasks", { prompt: command.value, sessionId: command.session, ...(command.agents[0] ? { agent: command.agents[0] } : {}), requestId: command.requestId ?? randomUUID() });
    const suffix = ["cancel", "recover", "run"].includes(command.action) ? `/${command.action === "run" ? "dispatch" : command.action}` : "";
    const result = await request(`/api/v2/tasks/${encodeURIComponent(command.value!)}${suffix}`, suffix ? {} : undefined);
    if (command.action === "result") {
      const data = result as { task?: GatewayTask; legacy?: { status: string } };
      if ((data.task?.status ?? data.legacy?.status) !== "completed") throw new Error("Task result is not complete");
    }
    return result;
  }
  const snapshot = await request("/api/ui/snapshot") as { hostId: string };
  return request("/api/ui/commands", await uiCommand(command, snapshot.hostId));
  }
}

async function uiCommand(command: Command, hostId: string): Promise<UiCommand> {
  const base: UiCommand = { version: 1, hostId, requestId: command.requestId ?? randomUUID(), targetId: command.session ?? null, name: "gateway.command", args: {} };
  if (command.object === "session") {
    if (command.action === "create") return { ...base, targetId: null, name: "session.create", args: { name: command.value!, agents: JSON.stringify(command.agents), allowed: JSON.stringify(command.allowed), ...(command.kind ? { entry: JSON.stringify({ kind: command.kind, account: command.account, conversation: command.conversation, ...(command.owner ? { owner: command.owner } : {}), ...(command.thread ? { threadId: command.thread } : {}) }) } : {}) } };
    return { ...base, targetId: command.value!, name: command.action === "select" ? "session.default" : `session.${command.action}`, args: command.action === "rename" ? { name: command.name! } : command.action === "admins" ? { admins: JSON.stringify(command.identities) } : command.action === "delete" ? { confirm: String(command.confirm === true) } : {} };
  }
  if (command.object === "agent") {
    if (command.action === "save") return { ...base, name: "agent.save", args: { id: command.value!, config: await readFile(resolve(command.definition!), "utf8") } };
    if (command.action === "check" || command.action === "delete") return { ...base, name: `agent.${command.action}`, args: { id: command.value!, ...(command.action === "delete" ? { confirm: String(command.confirm === true) } : {}) } };
    if (command.action === "default" || command.action === "allow") return { ...base, name: `agent.${command.action}`, args: { agents: JSON.stringify([command.value!, ...command.agents]) } };
    return { ...base, args: { text: `/agent create ${command.value}` } };
  }
  return { ...base, name: command.object === "task" ? "message.submit" : "gateway.command", args: { text: command.object === "task" && command.agents[0] ? `@${command.agents[0]} -- ${command.value}` : command.value! } };
}

function parse(args: readonly string[]): Command {
  const object = args[0] ?? "", action = object === "serve" ? "serve" : object === "command" ? "command" : args[1] ?? "";
  const allowed: Record<string, readonly string[]> = { serve: ["serve"], session: ["create", "list", "show", "select", "archive", "restore", "delete", "rename", "admins"], agent: ["list", "check", "save", "delete", "create", "default", "allow"], task: ["submit", "list", "status", "result", "cancel", "run", "recover"], channel: ["status"], delivery: ["retry", "retry-legacy"], command: ["command"], migrate: ["check", "run"] };
  if (!allowed[object]?.includes(action)) throw new Error("Unknown Gateway command");
  const result: Command = { object, action, directory: join(homedir(), ".may", "maybeclaw"), agents: [], allowed: [], identities: [] };
  const single = new Set<string>();
  const options: Record<string, readonly string[]> = {
    "serve.serve": ["--port", "--no-open"],
    "session.create": ["--agent", "--allow-agent", "--kind", "--account", "--conversation", "--owner", "--thread", "--request-id"],
    "session.rename": ["--name"], "session.admins": ["--identity"], "session.delete": ["--confirm"],
    "agent.save": ["--definition"], "agent.delete": ["--confirm"], "agent.create": ["--session", "--request-id"],
    "agent.default": ["--session", "--agent", "--request-id"], "agent.allow": ["--session", "--agent", "--request-id"],
    "task.submit": ["--session", "--agent", "--request-id"], "command.command": ["--session", "--request-id"],
    "delivery.retry": ["--confirm"], "delivery.retry-legacy": ["--confirm"],
  };
  const permitted = new Set(["--config", "--data-directory", "--server", "--password-env", ...(options[`${object}.${action}`] ?? [])]);
  const names = { "--data-directory": "directory", "--config": "config", "--server": "server", "--password-env": "passwordEnv", "--session": "session", "--request-id": "requestId", "--name": "name", "--account": "account", "--conversation": "conversation", "--kind": "kind", "--owner": "owner", "--thread": "thread", "--definition": "definition" } as const;
  for (let index = object === "serve" || object === "command" ? 1 : 2; index < args.length; index++) {
    const flag = args[index]!;
    if (!flag.startsWith("--")) { if (result.value !== undefined) throw new Error("Quote the message or name as one argument"); result.value = flag; continue; }
    if (!permitted.has(flag)) throw new Error(`Unsupported option for ${object} ${action}: ${flag}`);
    if (flag === "--no-open") { if (single.has(flag)) throw new Error(`Duplicate option: ${flag}`); single.add(flag); result.noOpen = true; continue; }
    if (flag === "--confirm") { if (single.has(flag)) throw new Error(`Duplicate option: ${flag}`); single.add(flag); result.confirm = true; continue; }
    const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`Missing value: ${flag}`);
    if (["--agent", "--allow-agent", "--identity"].includes(flag)) { (flag === "--agent" ? result.agents : flag === "--allow-agent" ? result.allowed : result.identities).push(value); continue; }
    if (single.has(flag)) throw new Error(`Duplicate option: ${flag}`); single.add(flag);
    if (flag === "--port") { result.port = Number(value); if (!Number.isSafeInteger(result.port) || result.port < 0 || result.port > 65535) throw new Error("--port must be 0..65535"); continue; }
    if (!(flag in names)) throw new Error(`Unsupported option: ${flag}. Model and directory options belong in Agent configuration.`);
    result[names[flag as keyof typeof names]] = value;
  }
  if (!["serve", "list", "status", "check", "run"].includes(action) && !result.value) throw new Error("A name, ID, or message is required");
  if (object === "task" && action !== "list" && !result.value) throw new Error("Task prompt or ID is required");
  if (object === "agent" && action !== "list" && !result.value) throw new Error("Agent ID is required");
  if ((["serve", "migrate", "channel"].includes(object) || action === "list") && result.value !== undefined) throw new Error("This command does not accept a positional argument");
  if (object === "session" && action === "create" && !result.agents.length) throw new Error("Session creation requires --agent <id>");
  if ((object === "task" && action === "submit" || object === "agent" && ["create", "default", "allow"].includes(action)) && !result.session) throw new Error("This operation requires --session <id>. Create a session with session create first.");
  if (object === "agent" && action === "save" && !result.definition) throw new Error("agent save requires --definition <json-file>");
  if (object === "task" && action === "submit" && result.agents.length > 1) throw new Error("Use one --agent to target a single Agent, or omit it to use the session defaults");
  if (object === "delivery" && !result.server) throw new Error("delivery retry requires --server <url>");
  if (!result.server && result.passwordEnv) throw new Error("--password-env requires --server");
  if (object === "migrate" && result.config) throw new Error("migrate uses only --data-directory");
  if (object === "session" && action === "rename" && !result.name) throw new Error("session rename requires --name <name>");
  if (object === "serve" && result.server || object === "migrate" && result.server) throw new Error("This command requires direct access to the data directory");
  if (result.server && (result.config || single.has("--data-directory"))) throw new Error("--server uses the server's configuration and data directory");
  if (result.kind && (!["private", "group"].includes(result.kind) || !result.account || !result.conversation || result.kind === "private" && !result.owner)) throw new Error("Entry requires --kind private|group, --account, --conversation and --owner for a private chat");
  if (!result.kind && (result.account || result.conversation || result.owner || result.thread)) throw new Error("Entry options require --kind");
  result.directory = resolve(result.directory); return result;
}
