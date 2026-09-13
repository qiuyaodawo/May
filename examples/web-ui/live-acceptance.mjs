// Opt-in live-provider acceptance: synthetic files, isolated stores, no channels.
import { mkdtemp, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { FileSessionStore } from "@may/session/file-store";
import { FileSessionCatalog } from "@may/session/catalog";
import { loadMayConfig } from "../../packages/config/dist/index.js";
import { selectProviderModel, createBuiltinProviderModel } from "../../packages/providers/dist/index.js";
import { MaybeCodeWorkspace, startMaybeCodeWebUI } from "../../apps/maybecode/dist/index.js";
import { MaybeClaw, MaybeClawHost, startControlServer, selectTaskModel, loadTaskModel } from "../../apps/maybeclaw/dist/index.js";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize billed model calls against the configured default provider.");
const config = await loadMayConfig();
const selection = selectProviderModel(config);
const resumeIndex = process.argv.indexOf("--resume");
const resuming = resumeIndex !== -1;
const root = await realpath(resuming ? process.argv[resumeIndex + 1] : await mkdtemp(join(tmpdir(), "may-live-web-acceptance-")));
if (dirname(root) !== await realpath(tmpdir()) || !basename(root).startsWith("may-live-web-acceptance-")) throw new Error("Resume must use an acceptance directory directly under the system temporary directory.");
const workspace = join(root, "workspace");
if (!resuming) {
await mkdir(workspace);
await writeFile(join(workspace, "greeting.ts"), 'export function greet(name: string): string {\n  return "Hello, " + name;\n}\n');
await writeFile(join(workspace, "requirements.txt"), "验收用虚构需求：问候函数应返回 你好， 加姓名。只修改 greeting.ts，不运行 Shell，不访问其它文件。\n任务统计：苹果 3 个，梨 5 个，总计应为 8 个。\n");
}
// Public only inside this disposable, loopback-only acceptance host; never production.
const token = "public-live-acceptance-token-disposable-only";
const budget = { maxModelCalls: 4, maxSteps: 4, maxToolCalls: 6, maxDurationMs: 120_000, maxTotalTokens: 32_768 };
const audit = resuming ? JSON.parse(await readFile(join(root, "acceptance-audit.json"), "utf8")) : { profile: selection.profile, adapter: selection.adapter, model: selection.model, calls: 0, completed: 0, reportedTokens: 0, interruptedOrFailed: 0, injectedFailures: 0, events: [] };
if (audit.profile !== selection.profile || audit.model !== selection.model || !Number.isSafeInteger(audit.calls) || audit.calls < 0) throw new Error("Acceptance audit does not match the current model configuration.");
let faultNext = false;
let writes = Promise.resolve();
const record = () => { const json = JSON.stringify(audit, null, 2); return writes = writes.then(() => writeFile(join(root, "acceptance-audit.json"), json)); };
const limited = s => createBuiltinProviderModel({ ...s, options: { ...s.options, maxTokens: 2048, maxOutputTokens: 2048 }, limits: { ...s.limits, maxOutputTokens: 2048 } });
function observed(base) {
  return {
    ...(base.limits ? { limits: base.limits } : {}),
    async *stream(request, options) {
      if (faultNext) { faultNext = false; audit.injectedFailures++; await record(); throw new Error("验收故障注入：模拟请求失败；本次未调用 Provider。"); }
      if (audit.calls >= 12 || audit.reportedTokens >= 65_536) throw new Error("Live acceptance budget exhausted; no request was sent.");
      const call = ++audit.calls;
      audit.events.push({ call, phase: "started", at: new Date().toISOString() }); await record();
      let completed = false;
      try {
        for await (const event of base.stream(request, options)) {
          if (event.type === "response.completed") {
            completed = true; audit.completed++; audit.reportedTokens += event.usage?.totalTokens ?? 0;
            audit.events.push({ call, phase: "completed", usage: event.usage, at: new Date().toISOString() }); await record();
          }
          yield event;
        }
      } finally {
        if (!completed) { audit.interruptedOrFailed++; audit.events.push({ call, phase: "interrupted-or-failed", at: new Date().toISOString() }); await record(); }
      }
    },
  };
}
async function start() {
  const app = await MaybeCodeWorkspace.open({ workspace, model: observed(limited(selection)), modelInfo: { profile: selection.profile, provider: selection.provider, adapter: selection.adapter, model: selection.model }, store: new FileSessionStore(join(root, "code-sessions")), catalog: new FileSessionCatalog(join(root, "catalog.jsonl")), autoResume: true, skills: false, skillDirectories: [], runBudget: budget });
  const code = await startMaybeCodeWebUI(app, { token, port: 3942 });
  try {
    const selected = await selectTaskModel(config.path, selection.profile);
    const claw = new MaybeClaw({ directory: join(root, "claw"), loadModel: async spec => observed(await loadTaskModel(spec, { createModel: limited })) });
    const host = await MaybeClawHost.start({ claw, selectSpec: async () => ({ ...selected, runBudget: budget, readDirectory: workspace }), adapters: [], startPaused: true });
    const tasks = await startControlServer({ host, token, port: 3943 });
    console.log(JSON.stringify({ root, code: code.url, claw: tasks.url, profile: audit.profile, adapter: audit.adapter, model: audit.model, maxCalls: 12 }));
    return { close: () => Promise.all([code.close(), tasks.close()]) };
  } catch (error) { await code.close(); throw error; }
}
let servers = await start(), commands = Promise.resolve();
process.stdin.setEncoding("utf8");
process.stdin.on("data", data => { commands = commands.then(async () => {
  const command = data.trim();
  if (command === "fault") { faultNext = true; console.log("One pre-request failure armed; no provider outage is being simulated externally."); }
  if (command === "restart") { await servers.close(); await delay(4000); servers = await start(); }
  if (command === "stop") { await servers.close(); await record(); process.stdin.pause(); }
}).catch(() => { console.error("Acceptance control failed; inspect local evidence without printing credentials."); process.exitCode = 1; }); });
const stop = () => { void servers.close().finally(() => process.stdin.pause()); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
