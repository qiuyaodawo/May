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
    commands: ["model.switch", "effort.set", "permission.set"],
    badges: () => app.permissionMode === "yolo" ? [{ label: "YOLO · Auto-approve", tone: "warning" }] : [],
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
        ...(effort.status === "known" ? [{ command: "effort.set", label: "Reasoning effort", value: effort.overridden ? effort.effectiveEffort ?? "default" : "default", options: [{ value: "default", label: `配置默认 (${resetEffort ?? "Provider"})` }, ...effort.efforts.map(value => ({ value, label: value }))] }] : []),
        { command: "permission.set", label: "Permissions", value: app.permissionMode, options: [
          { value: "default", label: "Default" }, { value: "yolo", label: "YOLO · Auto-approve" },
        ] }];
    },
    panels: async () => [
      { id: "permissions", title: "Permissions", fields: [{ label: "Mode", value: app.permissionMode === "yolo" ? "YOLO · Auto-approve" : "Default" }] },
      { id: "model", title: "模型", fields: [{ label: "当前模型", value: app.modelInfo?.model ?? "未知" }, { label: "Provider", value: app.modelInfo?.provider ?? "未知" }] },
      { id: "subagents", title: "子 Agent", ...subagentPanel(app) },      { id: "recovery", title: "恢复", fields: [{ label: "待处理项", value: String(app.listRecoveries?.().length ?? 0) }, { label: "处理方式", value: "使用 /recovery 查看证据并记录核查结果。" }] },
      ...(app.getGoal ? [{ id: "goal", title: "目标", fields: [{ label: "状态", value: formatGoal(app.getGoal()) }] }] : []),
      ...(options.terminal ? [{ id: "terminal", title: "终端", fields: [{ label: "共享会话", value: "MCP 交互可以在终端或当前页面处理。退出宿主会关闭 Web 服务。" }] }] : []),
    ],
    execute: command => commands.execute(command),
  });
  return host;
}

/** 活动请求的子任务树，条目数量有界，适合面板布局。 */
function subagentPanel(app: MaybeCodeController): { readonly fields: readonly { readonly label: string; readonly value: string }[] } {
  const state = app.getDelegationState?.();
  const requests = app.listDelegationRequests?.() ?? [];
  if (state === undefined && requests.length === 0) {
    return { fields: [{ label: "状态", value: "本次会话还没有子 Agent 请求。" }] };
  }
  const tasks = state?.tasks ?? requests[0]?.tasks ?? [];
  const fields = [{
    label: "当前请求",
    value: state === undefined ? "空闲" : `${state.status} · ${state.requestId}`,
  }];
  for (const task of [...tasks].sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id)).slice(0, 12)) {
    const detail = task.detail ?? (task.output === undefined ? "" : task.output.replace(/\s+/gu, " ").slice(0, 80));
    fields.push({
      label: `${"· ".repeat(Math.max(0, task.depth - 1))}${task.role}/${task.id}`,
      value: detail === "" ? task.status : `${task.status} · ${detail}`,
    });
  }
  if (state?.budget !== undefined) {
    // 估计值也计入 token 总计，界面必须说明它不是完整用量。
    fields.push({
      label: "请求用量",
      value: `${state.budget.modelCalls}/${state.budget.maxModelCalls} 次模型调用 · ` +
        `${state.budget.totalTokens} tokens${state.budget.usageComplete ? "" : "（含预留值计账）"}`,
    });
  }
  const pending = (app.listDelegationRequests?.() ?? []).flatMap((request) =>
    request.tasks.filter((task) => task.status === "recovery-required").map((task) => task.id));
  fields.push({
    label: "查看与恢复",
    value: pending.length === 0
      ? "/delegations 查看任务树，/delegations tools <任务> 查看工具记录"
      : `/delegations resolve <任务> <failed|cancelled> <核查结论>（待核对：${pending.join(", ")}）`,
  });
  return { fields };
}

export async function startMaybeCodeWebServer(host: ApplicationUiHost, options: { token: string; port?: number; browserLogin?: boolean; exit?: () => void }) {
  try {
    const extensionModule = await readFile(new URL("./web-extension.js", import.meta.url), "utf8");
    const diffBundle = await readFile(new URL("./dist/diff.js", import.meta.resolve("diff/package.json")), "utf8");
    const diffEsm = `${diffBundle}\nexport const { parsePatch } = globalThis.Diff;\n`;
    const assets = new Map(await webUiAssets("MaybeCode", "session", { extensionModule, ...(options.browserLogin === undefined ? {} : { browserLogin: options.browserLogin }) }));
    assets.set("/vendor-diff.js", { type: "text/javascript; charset=utf-8", body: diffEsm });
    return await startUiServer({ host, assets, ...options, close: () => host.close() });
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
