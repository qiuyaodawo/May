// Large, real shared-host fixture. All history is in memory; no provider or external tools.
import { setTimeout as delay } from "node:timers/promises";
import { AgentWorkspace, defineAgent } from "@may/application";
import { InMemorySessionStore } from "@may/session";
import { InMemorySessionCatalog } from "@may/session/catalog";
import { ApplicationUiHost } from "@may/ui-client/application";
import { startUiServer } from "@may/ui-client/server";
import { webUiAssets } from "@may/web-ui/assets";
const token = "public-reading-fixture-token-not-a-secret";
const store = new InMemorySessionStore(), catalog = new InMemorySessionCatalog();
const definition = defineAgent({ model: { async *stream(request, options) {
  const last = request.messages.at(-1), input = last?.role === "user" ? last.content.map(p => p.text ?? "").join("") : "工具已结束。";
  if (input.includes("审批")) { yield { type: "response.completed", message: { role: "assistant", content: [], toolCalls: [{ id: `call-${Date.now()}`, name: "fixture", input: { effect: "仅返回合成大文本，不访问文件" } }] } }; return; }
  let text = input.startsWith("seed ") ? `离线历史 ${input.slice(5)} · ${"上下文记录 ".repeat(15)}` : input;
  if (input.includes("慢速")) { text = ""; for (let i = 0; i < 100; i++) { await delay(150, undefined, { signal: options.signal }); const delta = `第 ${i + 1} 段合成输出。\n\n`; text += delta; yield { type: "text.delta", delta }; } }
  yield { type: "response.completed", message: { role: "assistant", content: [{ type: "text", text }] } };
} }, tools: [{ name: "fixture", description: "Synthetic output", inputSchema: { type: "object" }, execute: () => "大字段内容\n".repeat(15_000) + "深处检索命中" }], permissionPolicy: () => "ask", sessionHistory: false });
const app = await AgentWorkspace.open({ workspace: "只读分页验收 · 无真实文件", store, catalog, openApplication: selection => definition.open({ ...selection, store }) });
const host = new ApplicationUiHost(app, { product: { id: "reading", title: "长对话验收", resourceKind: "session", subtitle: "离线合成数据，无 API 消费", suggestions: ["审批大字段", "慢速阅读验收"] } });
for (let i = 0; i < 260; i++) await (await app.submit({ input: `seed ${i}` })).result;
await app.renameSession(app.sessionId, "长历史 · 520 条记录");
const longSession = app.sessionId;
for (let i = 0; i < 55; i++) { await app.newSession(); await app.renameSession(app.sessionId, `分页会话 ${i}`); }
await app.resumeSession(longSession);
const assets = new Map(await webUiAssets("阅读验收", "session"));
assets.set("/app.js", { type: "text/javascript; charset=utf-8", body: `import { UiClient } from "/ui/client.js"; import { mountWebUI } from "/webui/index.js"; const client = new UiClient(); mountWebUI(document.getElementById("app"), client); void client.connect(${JSON.stringify(token)});` });
const server = await startUiServer({ host, assets, token, port: 3945, close: () => host.close() });
console.log(`Reading fixture: ${server.url} · ${longSession} · prompts: 审批 / 慢速`);
const stop = () => { void server.close(); process.stdin.pause(); };
process.stdin.setEncoding("utf8"); process.stdin.on("data", text => { if (text.trim() === "stop") stop(); });
process.once("SIGINT", stop); process.once("SIGTERM", stop);
