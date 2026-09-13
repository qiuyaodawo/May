import { setTimeout as delay } from "node:timers/promises";
import { AgentWorkspace, defineAgent } from "@may/application";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "@may/ui-client/application";
import { startUiServer } from "@may/ui-client/server";
import { webUiAssets } from "@may/web-ui/assets";

// Explicit offline fixture: no provider, files, shell, channels, or persistent data.
const token = "public-offline-demo-token-not-a-secret";
const store = new InMemorySessionStore();
const model = {
  async *stream(request, options) {
    const last = request.messages.at(-1);
    const prompt = last?.role === "user" ? last.content.filter(p => p.type === "text").map(p => p.text).join("") : "";
    if (prompt.includes("审批")) {
      yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text: "接下来演示一个需要你确认的工具调用。此工具不读取或修改文件。" }], toolCalls: [{ id: `demo-${Date.now()}`, name: "review_preview", input: { scope: "仅演示数据", effect: "返回固定文本，不访问工作区" } }] } };
      return;
    }
    const text = last?.role === "tool" ? "审批交互已结束。\n\n你看到的是通过共享协议传递的工具结果；页面关闭或刷新不决定工具是否执行。" : `## 一个界面，不限制 Agent 的能力\n\n这是 **May WebUI 的离线演示**。下面的内容由固定脚本生成，没有调用真实模型，也不会执行你输入的业务请求。\n\n### 共同的交互，不同的工作方式\n\n| 应用 | 核心对象 | 产品扩展 |\n| --- | --- | --- |\n| MaybeCode | 会话与代码工作区 | 工具审批、变更预览 |\n| MaybeClaw | 持久任务 | 状态、恢复与投递 |\n\n共享层负责消息、连接状态和命令；应用仍然拥有执行策略与权限。\n\n\`\`\`typescript\nconst ui = new UiClient();\nmountWebUI(root, ui);\nawait ui.connect(controlToken);\n\`\`\`\n\n你可以新建会话、查看右侧详情，或发送包含“审批”的消息，体验确认流程。`;
    for (const chunk of text.match(/.{1,12}|\n/g) ?? []) { await delay(18, undefined, { signal: options.signal }); yield { type: "text.delta", delta: chunk }; }
    yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text }] } };
  },
};
const definition = defineAgent({ model, tools: [{ name: "review_preview", description: "Read-only fixture with no external effects", inputSchema: { type: "object" }, execute: () => ({ result: "演示完成", externalEffects: false }) }], permissionPolicy: () => "ask", sessionHistory: false });
const app = await AgentWorkspace.open({ workspace: "离线演示 · 内存会话", store, catalog: new InMemorySessionCatalog(), openApplication: selection => definition.open({ ...selection, store }) });
const host = new ApplicationUiHost(app, {
  product: { id: "demo", title: "May Preview", resourceKind: "session", subtitle: "一个共享的工作台，两种不同的 Agent。当前为离线演示，不连接模型或真实工作区。", suggestions: ["了解 WebUI 的共享架构", "体验工具审批", "查看 Markdown 与代码展示"] },
  panels: async () => [{ id: "demo", title: "演示环境", fields: [{ label: "模型", value: "固定脚本 · 无 API 消费" }, { label: "存储", value: "仅内存，重启清空" }, { label: "外部权限", value: "无文件、Shell 或消息发送权限" }] }],
});
const assets = new Map(await webUiAssets("May Preview", "session"));
assets.set("/app.js", { type: "text/javascript; charset=utf-8", body: `import { UiClient } from "/ui/client.js"; import { mountWebUI } from "/webui/index.js"; const client = new UiClient(); mountWebUI(document.getElementById("app"), client, { title: "May Preview", kind: "session" }); void client.connect(${JSON.stringify(token)});` });
const server = await startUiServer({ host, assets, token, port: 3941, close: () => host.close() });
console.log(`Offline Web UI preview: ${server.url}\nFixed fixture responses only. No model, filesystem or external actions. Ctrl+C to stop.`);
const stop = () => { void server.close(); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
