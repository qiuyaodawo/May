import { ApplicationUiHost, type ApplicationUiOptions } from "@may/ui-client/application";
import { UiError } from "@may/ui-client";
import { startUiServer } from "@may/ui-client/server";
import { webUiAssets } from "@may/web-ui/assets";
import type { MaybeCodeController } from "./controller.js";
import { readFile } from "node:fs/promises";
import { MaybeCodeWebCommands } from "./web-commands.js";
import { formatGoal } from "./goal-commands.js";

export function createMaybeCodeWebHost(app: MaybeCodeController, options: Pick<ApplicationUiOptions, "events" | "closeApplication"> & { terminal?: boolean } = {}) {
  const commands = new MaybeCodeWebCommands(app, () => host.changed());
  const host = new ApplicationUiHost(app, {
    ...options,
    product: { id: "maybecode", title: "MaybeCode", resourceKind: "session", subtitle: "围绕你的代码工作。查看工具执行，在关键操作前确认，让每一步都有迹可循。", suggestions: ["介绍这个项目的结构", "检查当前工作区的改动", "帮我定位一个问题"] },
    commands: ["model.switch", "effort.set"],
    concurrentCommands: ["console.execute", "console.action", "mcp.respond", "console.cancel", "message.submit"],
    interactionCommands: ["mcp.respond", "console.cancel", "console.execute"],
    controls: () => commands.controls(),
    available: name => commands.available(name),
    complete: text => commands.suggest(text),
    submit: async text => { if (text.trimStart().startsWith("/")) throw new UiError(400, "请通过命令输入执行斜杠命令。"); return undefined; },
    choices: async () => {
      const models = await app.listModels();
      const effort = await app.getReasoningEffort();
      const resetEffort = models.find(model => model.name === app.modelInfo?.profile)?.reasoningEffort ?? effort.defaultEffort;
      return [...(models.length ? [{ command: "model.switch", label: "模型配置", value: app.modelInfo?.profile ?? models[0]!.name, options: models.map(m => ({ value: m.name, label: m.name })) }] : []),
        ...(effort.status === "known" ? [{ command: "effort.set", label: "Reasoning effort", value: effort.overridden ? effort.effectiveEffort ?? "default" : "default", options: [{ value: "default", label: `配置默认 (${resetEffort ?? "Provider"})` }, ...effort.efforts.map(value => ({ value, label: value }))] }] : [])];
    },
    panels: async () => [
      { id: "model", title: "模型", fields: [{ label: "当前模型", value: app.modelInfo?.model ?? "未知" }, { label: "Provider", value: app.modelInfo?.provider ?? "未知" }] },
      { id: "recovery", title: "恢复", fields: [{ label: "待处理项", value: String(app.listRecoveries?.().length ?? 0) }, { label: "处理方式", value: "使用 /recovery 查看证据并记录核查结果。" }] },
      ...(app.getGoal ? [{ id: "goal", title: "目标", fields: [{ label: "状态", value: formatGoal(app.getGoal()) }] }] : []),
      ...(options.terminal ? [{ id: "terminal", title: "终端", fields: [{ label: "共享会话", value: "MCP 交互可以在终端或当前页面处理。退出宿主会关闭 Web 服务。" }] }] : []),
    ],
    execute: command => commands.execute(command),
  });
  return host;
}

export async function startMaybeCodeWebServer(host: ApplicationUiHost, options: { token: string; port?: number; browserLogin?: boolean; exit?: () => void }) {
  try {
    const extensionModule = await readFile(new URL("./web-extension.js", import.meta.url), "utf8");
    return await startUiServer({ host, assets: await webUiAssets("MaybeCode", "session", { extensionModule, ...(options.browserLogin === undefined ? {} : { browserLogin: options.browserLogin }) }), ...options, close: () => host.close() });
  }
  catch (error) { await host.close(); throw error; }
}

export async function startMaybeCodeWebUI(app: MaybeCodeController, options: { token: string; port?: number }) {
  return startMaybeCodeWebServer(createMaybeCodeWebHost(app), options);
}

export async function runMaybeCodeWebUI(app: MaybeCodeController, options: { port?: number; write: (text: string) => void }): Promise<void> {
  const token = process.env.MAYBECODE_CONTROL_TOKEN ?? "";
  if (!token) { await app.close(); throw new Error("Set MAYBECODE_CONTROL_TOKEN (32..256 printable ASCII characters) before starting --ui web."); }
  const server = await startMaybeCodeWebUI(app, { token, ...(options.port === undefined ? {} : { port: options.port }) });
  options.write(`MaybeCode Web UI: ${server.url}\nEnter MAYBECODE_CONTROL_TOKEN in the connection dialog. Closing a browser tab does not stop the agent. Ctrl+C stops the host.\n`);
  const stop = () => { void server.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try { await server.closed; await server.close(); }
  finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
}
