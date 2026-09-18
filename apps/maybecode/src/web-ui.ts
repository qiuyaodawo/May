import { ApplicationUiHost, type ApplicationUiOptions } from "@may/ui-client/application";
import { commandArgs, UiError } from "@may/ui-client";
import { startUiServer } from "@may/ui-client/server";
import { webUiAssets } from "@may/web-ui/assets";
import type { MaybeCodeController } from "./controller.js";
import { readFile } from "node:fs/promises";

export function createMaybeCodeWebHost(app: MaybeCodeController, options: Pick<ApplicationUiOptions, "events" | "closeApplication"> & { terminal?: boolean } = {}) {
  return new ApplicationUiHost(app, {
    ...options,
    product: { id: "maybecode", title: "MaybeCode", resourceKind: "session", subtitle: "围绕你的代码工作。查看工具执行，在关键操作前确认，让每一步都有迹可循。", suggestions: ["介绍这个项目的结构", "检查当前工作区的改动", "帮我定位一个问题"] },
    commands: ["model.switch"],
    choices: async () => {
      const models = await app.listModels();
      return models.length ? [{ command: "model.switch", label: "模型配置", value: app.modelInfo?.profile ?? models[0]!.name, options: models.map(m => ({ value: m.name, label: m.name })) }] : [];
    },
    panels: async () => [
      { id: "model", title: "模型", fields: [{ label: "当前模型", value: app.modelInfo?.model ?? "未知" }, { label: "Provider", value: app.modelInfo?.provider ?? "未知" }] },
      { id: "recovery", title: "恢复", fields: [{ label: "待处理项", value: String(app.listRecoveries?.().length ?? 0) }, { label: "处理方式", value: "如有未决执行，请先在 CLI 核对恢复证据。不会自动重放工具。" }] },
      ...(options.terminal ? [{ id: "terminal", title: "终端", fields: [{ label: "MCP 交互", value: "MCP 表单与授权请求请在当前终端处理。退出终端会关闭 Web 服务。" }] }] : []),
    ],
    execute: async command => {
      if (command.name !== "model.switch") throw new UiError(400, "不支持的命令。");
      commandArgs(command, ["value"]); await app.switchModel(command.args.value!); return { selectedId: app.sessionId };
    },
  });
}

export async function startMaybeCodeWebServer(host: ApplicationUiHost, options: { token: string; port?: number; browserLogin?: boolean }) {
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
  await new Promise<void>((resolve, reject) => {
    const stop = () => { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); void server.close().then(resolve, reject); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  });
}
