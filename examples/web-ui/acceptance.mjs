// Repository-only browser acceptance fixture. Uses real app hosts, never real providers.
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { MaybeCodeWorkspace, startMaybeCodeWebUI } from "../../apps/maybecode/dist/index.js";
import { MaybeClaw, MaybeClawHost, startControlServer, DEFAULT_TASK_BUDGET, digest } from "../../apps/maybeclaw/dist/index.js";

const root = await realpath(await mkdtemp(join(tmpdir(), "may-browser-acceptance-")));
const workspace = join(root, "workspace");
await mkdir(workspace);
await writeFile(join(workspace, "fixture.txt"), "before acceptance\n");
const token = "public-browser-acceptance-token-not-a-secret";
const completed = (text, toolCalls) => ({ type: "response.completed", message: { role: "assistant", content: [{ type: "text", text }], ...(toolCalls ? { toolCalls } : {}) }, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } });
const model = {
  async *stream(request, options) {
    const last = request.messages.at(-1);
    const prompt = last?.role === "user" ? last.content.filter(p => p.type === "text").map(p => p.text).join("") : "";
    if (prompt.includes("错误")) throw new Error("验收用模拟模型错误（未调用外部 API）");
    if (prompt.includes("审批")) {
      yield completed("准备修改隔离目录中的 fixture.txt，请检查变更并审批。", [{ id: `write-${Date.now()}`, name: "write", input: { path: "fixture.txt", content: "after acceptance\n中文内容\n" } }]);
      return;
    }
    if (prompt.includes("读取")) {
      yield completed("读取隔离验收文件。", [{ id: `read-${Date.now()}`, name: "read", input: { path: "fixture.txt" } }]);
      return;
    }
    const base = "## 浏览器验收结果\n\n这是 **离线模拟模型**，实际运行的是产品宿主。\n\n| 检查 | 状态 |\n| --- | --- |\n| 中文输入 | 已接收 |\n| Markdown | 可阅读 |\n\n```typescript\nconst message = '你好，May';\nconsole.log(message);\n```\n\n<script>alert('仅文本，不应执行')</script>\n\n";
    const text = last?.role === "tool" ? "工具调用已结束。\n\n" + base : base + (prompt.includes("长文") || prompt.includes("慢速") ? Array.from({ length: 35 }, (_, i) => `### 第 ${i + 1} 段\n\n这是用于检查流式输出、阅读位置和取消操作的验收文本。\n\n`).join("") : "验收响应结束。");
    for (const chunk of text.match(/.{1,16}|\n/g) ?? []) {
      await delay(prompt.includes("慢速") ? 250 : 12, undefined, { signal: options.signal });
      yield { type: "text.delta", delta: chunk };
    }
    yield completed(text);
  },
};
const modelInfo = profile => ({ profile, provider: "fixture", adapter: "fixture", model: `offline-${profile}` });
async function start() {
const app = await MaybeCodeWorkspace.open({ workspace, model, modelInfo: modelInfo("fixture-a"), modelProfiles: ["fixture-a", "fixture-b"].map(name => ({ name, ...modelInfo(name), isDefault: name === "fixture-a" })), createModelConfiguration: profile => ({ model, modelInfo: modelInfo(profile) }), store: new FileSessionStore(join(root, "sessions")), catalog: new FileSessionCatalog(join(root, "catalog.jsonl")), autoResume: true });
const code = await startMaybeCodeWebUI(app, { token, port: 3942 });
const claw = new MaybeClaw({ directory: join(root, "claw"), loadModel: () => model });
const spec = { configPath: join(root, "fixture-config.json"), modelProfile: "fixture", modelFingerprint: digest("fixture"), runBudget: DEFAULT_TASK_BUDGET, readDirectory: workspace };
const host = await MaybeClawHost.start({ claw, selectSpec: async () => spec, startPaused: true });
const tasks = await startControlServer({ host, token, port: 3943 });
console.log(JSON.stringify({ code: code.url, claw: tasks.url, root, token, note: "Disposable local fixture; no real model, channels, or user workspace." }));
return { close: () => Promise.all([code.close(), tasks.close()]) };
}
let servers = await start();
let commands = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => { commands = commands.then(async () => {
  if (data.trim() === "restart") { await servers.close(); await delay(4000); servers = await start(); }
  if (data.trim() === "stop") { await servers.close(); process.stdin.pause(); }
}).catch(error => { console.error(error); process.exitCode = 1; }); });
const stop = () => { void servers.close().finally(() => process.stdin.pause()); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
