import { randomUUID } from "node:crypto";
import { loadMayConfig } from "@may/config";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadTaskModel, selectTaskModel, type ModelDependencies } from "./configured.js";
import { MaybeClaw } from "./service.js";
import { validateId, type TaskSnapshot } from "./types.js";
import { hostSettings, secretFromEnv, channelSecret } from "./settings.js";
import { TelegramAdapter, FeishuAdapter, type ChannelAdapter } from "./channels.js";
import { MaybeClawHost } from "./host.js";
import { startControlServer } from "./server.js";

export const MAYBECLAW_USAGE = `MaybeClaw — local durable tasks (developer preview)

maybeclaw task submit <prompt> [--request-id <key>] [--enqueue]
    [--config <path>] [--model <profile>] [--read-directory <path>]
maybeclaw task run <id>
maybeclaw task status <id>
maybeclaw task result <id>
maybeclaw task cancel <id>
maybeclaw task recover <id>
maybeclaw task list
maybeclaw serve [--port <number>] [--config <path>] [--model <profile>]
    [--read-directory <path>] [--token-env <name>]

Server client: task submit/status/result/cancel/recover/list/run --server <url>
    [--token-env <name>]. Client run requests dispatch, not synchronous completion.

All commands accept --data-directory <path> (default: ~/.may/maybeclaw).
Submit runs in the foreground unless --enqueue is given. Queued tasks require
task run or a running serve process. Reusing a request id never reruns a task.
Serve provides a loopback-only Web UI/API and configured Feishu/Telegram private chats.
Set MAYBECLAW_CONTROL_TOKEN (32..256 ASCII characters); never put tokens in URLs.
No scheduling, shell, writes, approvals or long-term memory yet.
--read-directory explicitly grants read access; its text may be sent to your model.
Status is a persisted snapshot; recover reconciles stopped work without model calls.
Exit: 0 success/accepted/query; 1 failed, cancelled, blocked or unavailable; 2 syntax.
`;

export interface MaybeClawDependencies extends ModelDependencies {
  readonly stdout?: { write(text: string): unknown };
  readonly stderr?: { write(text: string): unknown };
  readonly signal?: AbortSignal;
}

export async function runMaybeClaw(args: readonly string[], deps: MaybeClawDependencies = {}): Promise<number> {
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  let command: Command;
  try { command = parse(args); }
  catch (error) { err.write(`${message(error)}\n\n${MAYBECLAW_USAGE}`); return 2; }
  if (command.action === "help") { out.write(MAYBECLAW_USAGE); return 0; }
  const claw = new MaybeClaw({ directory: command.directory, loadModel: (spec) => loadTaskModel(spec, deps) });
  const print = (value: unknown) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  try {
    if (command.action === "serve") {
      if (deps.signal === undefined) throw new Error("serve requires an AbortSignal for shutdown; pass dependencies.signal");
      const token = secretFromEnv(command.tokenEnv ?? "MAYBECLAW_CONTROL_TOKEN");
      const config = await (deps.loadConfig ?? loadMayConfig)(command.config ? { path: command.config } : {});
      const settings = hostSettings(config);
      const adapters: ChannelAdapter[] = [];
      const channelErrors: Record<string, string> = {};
      if (settings.telegram?.enabled) {
        try { adapters.push(new TelegramAdapter(settings.telegram, channelSecret(settings.telegram.botToken, settings.telegram.botTokenEnv))); }
        catch { channelErrors.telegram = "credential-error"; }
      }
      if (settings.feishu?.enabled) {
        try { adapters.push(new FeishuAdapter(settings.feishu, channelSecret(settings.feishu.appSecret, settings.feishu.appSecretEnv))); }
        catch { channelErrors.feishu = "credential-error"; }
      }
      // Validate model selection before starting receivers, without calling the model.
      await selectTaskModel(config.path, command.model, deps);
      const host = await MaybeClawHost.start({ claw, maxConcurrent: settings.maxConcurrent, adapters, channelErrors, startPaused: true,
        selectSpec: async () => ({ ...(await selectTaskModel(config.path, command.model, deps)),
          ...(command.readDirectory ? { readDirectory: resolve(command.readDirectory) } : {}) }) });
      let server: Awaited<ReturnType<typeof startControlServer>> | undefined;
      try {
        server = await startControlServer({ host, token, ...(command.port === undefined ? {} : { port: Number(command.port) }) });
        print({ url: server.url, directory: command.directory, channels: host.status().channels,
          note: "Keep this process running. Closing a browser/client does not cancel work. Ctrl+C stops receivers and cancels active runs." });
        if (!deps.signal?.aborted) await new Promise<void>((resolve) => deps.signal?.addEventListener("abort", () => resolve(), { once: true }));
        return 0;
      } finally { if (server) await server.close(); else await host.close(); }
    }
    if (command.server) {
      const url = new URL(command.server);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("--server must be a loopback http://127.0.0.1:<port> URL");
      const token = secretFromEnv(command.tokenEnv ?? "MAYBECLAW_CONTROL_TOKEN");
      const action = command.action;
      const path = action === "submit" || action === "list" ? "/api/tasks" : `/api/tasks/${command.value}${["cancel", "recover", "run"].includes(action) ? `/${action === "run" ? "dispatch" : action}` : ""}`;
      const body = action === "submit" ? { prompt: command.value, requestId: command.requestId ?? randomUUID() } : ["cancel", "recover", "run"].includes(action) ? {} : undefined;
      const response = await fetch(new URL(path, url), { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(deps.signal ? [deps.signal] : [])]) });
      const data = await response.json() as { error?: string; task?: TaskSnapshot };
      if (!response.ok) throw new Error(data.error ?? "Control API request failed");
      if (action === "result") {
        if (data.task?.status !== "completed") throw new Error(`Result is unavailable: ${data.task?.status}`);
        print({ id: data.task.id, verification: data.task.verification, result: data.task.result });
      } else print(data);
      return 0;
    }
    if (command.action === "submit") {
      const selection = await selectTaskModel(command.config, command.model, deps);
      const submitted = await claw.submit({ requestId: command.requestId ?? randomUUID(), prompt: command.value!, ...selection,
        ...(command.readDirectory === undefined ? {} : { readDirectory: resolve(command.readDirectory) }) });
      print({ id: submitted.task.id, requestId: submitted.task.spec.requestId, created: submitted.created, status: submitted.task.status });
      if (!submitted.created || command.enqueue) return 0;
      const task = await claw.run(submitted.task.id, deps.signal); print(task); return exitCode(task);
    }
    if (command.action === "list") {
      print((await claw.store.list()).map(({ id, status, createdAt, verification }) => ({ id, status, createdAt, verification })));
      return 0;
    }
    const id = command.value!;
    if (command.action === "cancel") { print(await claw.cancel(id)); return 0; }
    if (command.action === "status") { print(await claw.status(id)); return 0; }
    if (command.action === "result") {
      const { task } = await claw.status(id);
      if (task.status !== "completed") throw new Error(`Result is unavailable: ${task.status}`);
      // JSON encoding avoids interpreting model output as terminal control sequences.
      print({ id, verification: task.verification, result: task.result }); return 0;
    }
    const task = command.action === "run" ? await claw.run(id, deps.signal) : await claw.recover(id);
    print(task); return exitCode(task);
  } catch (error) { err.write(`${message(error)}\n`); return 1; }
}

type Action = "help" | "serve" | "submit" | "run" | "status" | "result" | "cancel" | "recover" | "list";
interface Command {
  action: Action; directory: string; value?: string; config?: string; model?: string;
  requestId?: string; readDirectory?: string; enqueue?: boolean;
  port?: string; tokenEnv?: string; server?: string;
}

function parse(args: readonly string[]): Command {
  if (args.length === 0 || (args.length === 1 && ["--help", "-h"].includes(args[0]!))) return { action: "help", directory: "" };
  if (args[0] !== "serve" && (args[0] !== "task" || !["submit", "run", "status", "result", "cancel", "recover", "list"].includes(args[1] ?? ""))) throw new Error("Expected serve or task <action>");
  const command: Command = { action: args[0] === "serve" ? "serve" : args[1] as Action, directory: join(homedir(), ".may", "maybeclaw") };
  const seen = new Set<string>();
  const names = { "--data-directory": "directory", "--config": "config", "--model": "model",
    "--request-id": "requestId", "--read-directory": "readDirectory", "--port": "port", "--token-env": "tokenEnv", "--server": "server" } as const;
  for (let i = command.action === "serve" ? 1 : 2; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("--")) {
      if (seen.has(token)) throw new Error(`Duplicate option: ${token}`);
      seen.add(token);
      const allowed = command.action === "serve" ? ["--data-directory", "--config", "--model", "--read-directory", "--port", "--token-env"] : command.action === "submit" ? ["--data-directory", "--config", "--model", "--read-directory", "--request-id", "--enqueue", "--server", "--token-env"] : ["--data-directory", "--server", "--token-env"];
      if (!allowed.includes(token)) throw new Error(`Option not accepted for this action: ${token}`);
      if (token === "--enqueue") { command.enqueue = true; continue; }
      if (!(token in names)) throw new Error(`Unknown option: ${token}`);
      const value = args[++i];
      if (value === undefined || !value.trim() || value.startsWith("--")) throw new Error(`Missing value: ${token}`);
      command[names[token as keyof typeof names]] = value;
    } else {
      if (command.value !== undefined || ["list", "serve"].includes(command.action)) throw new Error("Unexpected argument; quote the prompt as one argument");
      command.value = token;
    }
  }
  if (!["list", "serve"].includes(command.action) && !command.value?.trim()) throw new Error("Missing task prompt or id");
  if (!["submit", "list", "serve"].includes(command.action)) validateId(command.value!);
  if (command.server && (command.config || command.model || command.readDirectory || command.enqueue || seen.has("--data-directory"))) throw new Error("Server mode uses host configuration, read scope and data directory; local options are not accepted");
  if (command.tokenEnv && !command.server && command.action !== "serve") throw new Error("--token-env requires serve or --server");
  if (command.port && (!/^\d+$/.test(command.port) || Number(command.port) < 1 || Number(command.port) > 65535)) throw new Error("--port must be 1..65535");
  command.directory = resolve(command.directory);
  if (command.config !== undefined) command.config = resolve(command.config);
  return command;
}

function exitCode(task: TaskSnapshot): number { return ["completed", "queued"].includes(task.status) ? 0 : 1; }
function message(error: unknown): string { return JSON.stringify(error instanceof Error ? error.message : "MaybeClaw operation failed"); }
