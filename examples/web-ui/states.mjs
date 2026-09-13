// Read-only component gallery: synthetic evidence, no runtime, provider, or external effects.
import { randomUUID } from "node:crypto";
import { startUiServer } from "@may/ui-client/server";
import { webUiAssets } from "@may/web-ui/assets";

const token = "public-ui-states-fixture-not-a-secret";
const hostId = randomUUID();
const states = ["awaiting-approval", "running", "completed", "failed", "denied", "not-started", "unknown"];
const blocks = states.map((status, i) => ({ id: `tool:fixture:${i}`, kind: "tool", runId: "fixture", toolCallId: String(i), title: status === "failed" ? "broken_renderer" : "fixture_tool", status,
  input: '{"scope":"synthetic only"}', text: status === "completed" ? "Fixture output" : "",
  ...(status === "awaiting-approval" ? { approval: { id: "historical", status: "pending" } } : {}),
  ...(status === "failed" ? { diagnostic: { code: "FIXTURE_ERROR", message: "<script>仅文本，不执行</script>" }, presentation: { kind: "fixture", version: 1, text: "Renderer threw; safe presentation fallback" } } : {}),
  ...(status === "unknown" ? { presentation: { kind: "fixture", version: 99, text: "Unknown version; safe text fallback" } } : {}) }));
blocks.push({ id: "assistant:fixture:1", kind: "assistant", text: "这是中断前的部分回答。", status: "interrupted" });
blocks.push({ id: "run:fixture", kind: "notice", text: "模拟模型失败", status: "failed", diagnostic: { code: "FIXTURE_ERROR", message: "模拟错误；没有调用外部 API。" } });
const host = {
  hostId,
  async snapshot() { return { version: 1, hostId, revision: 1, product: { id: "states", title: "UI 状态验收 · 只读夹具", subtitle: "合成状态，不代表真实运行。", resourceKind: "task", suggestions: [] }, resources: [], selectedId: "fixture", blocks, interactions: [], commands: [], panels: [], choices: [] }; },
  async execute() { throw new Error("Read-only fixture"); },
  subscribe() { return () => {}; },
};
const assets = new Map(await webUiAssets("UI states", "task"));
assets.set("/app.js", { type: "text/javascript; charset=utf-8", body: `
import { UiClient } from "/ui/client.js";
import { mountWebUI } from "/webui/index.js";
const text = value => { const node = document.createElement("p"); node.textContent = value; return node; };
const extensions = {
  tools: { fixture_tool: () => text("产品工具扩展 · 公共状态和原始输入仍保留"), broken_renderer: () => { throw new Error("Fixture render failure"); } },
  presentations: { fixture: { 1: () => { throw new Error("Fixture presentation failure"); } } },
  diagnostics: { FIXTURE_ERROR: () => text("产品诊断扩展 · 这不是重试按钮") }
};
const client = new UiClient();
mountWebUI(document.getElementById("app"), client, { extensions });
void client.connect(${JSON.stringify(token)});
` });
const server = await startUiServer({ host, assets, token, port: 3944 });
console.log(`Read-only synthetic UI states: ${server.url}`);
const stop = () => { void server.close(); process.stdin.pause(); };
process.stdin.setEncoding("utf8"); process.stdin.on("data", value => { if (value.trim() === "stop") stop(); });
process.once("SIGINT", stop); process.once("SIGTERM", stop);
