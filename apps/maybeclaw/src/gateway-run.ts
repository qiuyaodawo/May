import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline/promises";
import open from "open";
import { getDefaultMayConfigPath, loadMayConfig } from "@sortedyuan/may/config";
import { omitUndefined } from "@sortedyuan/may/core";
import type { Server } from "node:http";
import { inspectGatewaySetup, startGatewaySetup } from "./gateway-setup.js";
import { parse, uiCommand, type Command } from "./gateway-command-line.js";
import { remote } from "./gateway-remote.js";
import { AgentGateway } from "./gateway.js";
import { GatewayHost } from "./gateway-host.js";
import { gatewaySettings } from "./gateway-settings.js";
import { GatewayUiHost, controlActor } from "./gateway-ui.js";
import { startGatewayServer } from "./plugins/web-api.js";
import { hostSettings } from "./settings.js";
import { createGatewayChannelPlugins } from "./plugins/channels.js";
import type { GatewayTask } from "./gateway-types.js";
import type { MaybeClawDependencies } from "./run.js";

import { GATEWAY_USAGE } from "./usage.js";
export { GATEWAY_USAGE } from "./usage.js";

async function runGatewayService(
  command: Command,
  deps: MaybeClawDependencies,
  launch: { openBrowser?: boolean },
): Promise<number> {
  if (!deps.signal) throw new Error("serve requires an AbortSignal");
  if (deps.signal.aborted) return 0;
  const signal = deps.signal,
    path = resolve(command.config ?? getDefaultMayConfigPath());
  const print = (value: unknown) => (deps.stdout ?? process.stdout).write(`${JSON.stringify(value, null, 2)}\n`);
  let gateway: AgentGateway | undefined, host: GatewayHost | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined,
    setup: Awaited<ReturnType<typeof startGatewaySetup>> | undefined;
  let stopped!: () => void;
  const aborted = new Promise<void>((resolve) => {
    stopped = resolve;
    signal.addEventListener("abort", stopped, { once: true });
  });
  async function activate(listener?: Server) {
    const config = await (deps.loadConfig ?? loadMayConfig)({ path });
    gateway = new AgentGateway({
      directory: command.directory,
      configPath: config.path,
      settings: gatewaySettings(config),
    });
    host = await GatewayHost.start({ gateway, plugins: createGatewayChannelPlugins(hostSettings(config)) });
    server = await startGatewayServer({
      gateway,
      ...(listener ? { server: listener } : {}),
      ...omitUndefined({ port: command.port }),
      status: () => host!.status(),
      close: () => host!.close(),
    });
    print({
      url: server.url,
      ...(server.publicUrl ? { publicUrl: server.publicUrl } : {}),
      directory: command.directory,
      channels: host.status().channels,
    });
  }
  try {
    if ((await inspectGatewaySetup(path)).needsSetup) {
      setup = await startGatewaySetup({ path, ...omitUndefined({ port: command.port }), activate });
      print({
        initialization: true,
        initializationFile: setup.launchPath,
        message: "请在本机浏览器打开初始化文件，设置管理员密码。",
      });
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
    if (server) await server.close();
    else if (host) await host.close();
    else await gateway?.close();
  }
}

export async function runGatewayCommand(
  args: readonly string[],
  deps: MaybeClawDependencies,
  launch: { openBrowser?: boolean } = {},
): Promise<number> {
  const out = deps.stdout ?? process.stdout,
    err = deps.stderr ?? process.stderr;
  const print = (value: unknown) => out.write(`${JSON.stringify(value, null, 2)}\n`);
  let command: Command;
  try {
    command = parse(args);
  } catch (error) {
    err.write(`${error instanceof Error ? error.message : "Invalid command"}\n${GATEWAY_USAGE}`);
    return 2;
  }
  try {
    if (command.server) {
      print(await remote(command));
      return 0;
    }
    if (command.object === "serve") return await runGatewayService(command, deps, launch);
    const config = await (deps.loadConfig ?? loadMayConfig)(command.config ? { path: command.config } : {});
    const settings = gatewaySettings(config),
      gateway = new AgentGateway({ directory: command.directory, configPath: config.path, settings });
    const ui = new GatewayUiHost(gateway);
    try {
      if (command.object === "session" && command.action === "list") {
        print(gateway.sessions(controlActor));
        return 0;
      }
      if (command.object === "session" && command.action === "show") {
        print(gateway.session(command.value!, controlActor));
        return 0;
      }
      if (command.object === "agent" && command.action === "list") {
        print(gateway.status().agents);
        return 0;
      }
      if (command.object === "channel") {
        print({
          configuredEntries: gateway
            .sessions(controlActor)
            .filter((session) => session.entry)
            .map((session) => ({ sessionId: session.id, entry: session.entry })),
          gateway: gateway.status(),
        });
        return 0;
      }
      if (command.object === "task" && command.action !== "submit") {
        if (command.action === "list") {
          print({ tasks: gateway.tasks(controlActor) });
          return 0;
        }
        const task = gateway.task(command.value!, controlActor);
        if (!task) throw new Error("Task not found");
        if (command.action === "cancel")
          await gateway.stop(gateway.session(task.sessionId, controlActor), controlActor, undefined, task.id);
        else if (command.action === "run") {
          await gateway.dispatchTask(task.id, controlActor);
          const tasks = await waitForTasks(gateway, [task.id], deps);
          print(tasks);
          return tasks.some((item) => item.status !== "completed") ? 1 : 0;
        } else if (command.action === "recover") await gateway.recoverTask(task.id, controlActor);
        const current = gateway.task(task.id, controlActor)!;
        if (command.action === "result" && current.status !== "completed")
          throw new Error(`Result unavailable: ${current.status}`);
        print(current);
        return 0;
      }
      if (command.object === "task" && command.action === "submit") {
        const receipt = await gateway.handle(
          command.agents[0] ? `@${command.agents[0]} -- ${command.value}` : command.value!,
          controlActor,
          { requestId: `cli:${command.requestId ?? randomUUID()}`, sessionId: command.session! },
        );
        print(receipt);
        const tasks = await waitForTasks(gateway, receipt.taskIds ?? [], deps);
        print(tasks);
        return tasks.some((task) => task.status !== "completed") ? 1 : 0;
      }
      const request = await uiCommand(command, ui.hostId);
      const result = await ui.execute(request);
      print(result);
      return 0;
    } finally {
      ui.close();
      await gateway.close();
    }
  } catch (error) {
    err.write(`${JSON.stringify(error instanceof Error ? error.message : "Gateway operation failed")}\n`);
    return 1;
  }
}

async function waitForTasks(
  gateway: AgentGateway,
  taskIds: readonly string[],
  deps: MaybeClawDependencies,
): Promise<GatewayTask[]> {
  const graphIds = new Set(taskIds.map((id) => gateway.task(id, controlActor)?.graphId));
  const current = () => gateway.tasks(controlActor).filter((task) => graphIds.has(task.graphId));
  let tasks = current();
  while (tasks.some((task) => ["queued", "running", "waiting", "cancelling"].includes(task.status))) {
    if (deps.signal?.aborted) {
      for (const id of taskIds) {
        const task = gateway.task(id, controlActor)!;
        await gateway.stop(gateway.session(task.sessionId, controlActor), controlActor, undefined, id);
      }
      return current();
    }
    const approval = gateway
      .approvals(controlActor)
      .find((item) => item.status === "pending" && tasks.some((task) => task.id === item.taskId));
    if (approval) {
      if (!process.stdin.isTTY) {
        await gateway.resolveApproval(approval.id, controlActor, "deny");
        throw new Error(
          "Foreground work requires approval. Use serve and task submit --server for commands without an interactive terminal.",
        );
      }
      const reader = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await reader.question(
          `${approval.text}\nallow${approval.grantKey ? "/allow-session" : ""}${approval.persistent ? "/allow-persistent" : ""}/deny: `,
          deps.signal ? { signal: deps.signal } : {},
        );
        if (
          ![
            "allow",
            "deny",
            ...(approval.grantKey ? ["allow-session"] : []),
            ...(approval.persistent ? ["allow-persistent"] : []),
          ].includes(answer)
        )
          throw new Error("Invalid approval decision");
        await gateway.resolveApproval(
          approval.id,
          controlActor,
          answer as "allow" | "allow-session" | "allow-persistent" | "deny",
        );
      } finally {
        reader.close();
      }
    }
    await gateway.maintain();
    await delay(100);
    tasks = current();
  }
  return tasks;
}
