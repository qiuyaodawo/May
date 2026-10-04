import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { AgentApplication } from "../packages/application/dist/index.js";
import { loadMayConfig } from "../packages/config/dist/index.js";
import { createBuiltinProviderModel, selectProviderModel } from "../packages/providers/dist/index.js";
import { FileSessionStore } from "../packages/session/dist/file-store.js";
import { Scheduler, TaskRejectedError } from "../packages/scheduler/dist/index.js";
import { SqliteSchedulerStore } from "../packages/scheduler/dist/sqlite-store.js";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const verificationRoot = join(repository, "scheduler-verification");
await mkdir(verificationRoot, { recursive: true });
const directory = await mkdtemp(join(verificationRoot, "live-agent-"));
const config = await loadMayConfig();
const selection = selectProviderModel(config);
const model = createBuiltinProviderModel(selection);
const host = new DatabaseSync(join(directory, "host.sqlite"));
host.exec("PRAGMA synchronous = FULL; CREATE TABLE tasks (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL) STRICT");
const receipts = new EventEmitter();
const dispatcher = {
  async submit(request) {
    if (request.handler !== "ai-brief") throw new TaskRejectedError("Unknown task handler");
    const existing = host.prepare("SELECT request FROM tasks WHERE id = ?").get(request.executionId);
    if (existing) {
      assert.equal(existing.request, JSON.stringify(request));
      return { taskId: request.executionId };
    }
    host.prepare("INSERT INTO tasks (id, request, status) VALUES (?, ?, 'accepted')").run(request.executionId, JSON.stringify(request));
    receipts.emit("accepted", { request, acceptedAt: new Date().toISOString() });
    return { taskId: request.executionId };
  }
};
const scheduler = Scheduler.open({
  store: SqliteSchedulerStore.open(join(directory, "scheduler.sqlite")),
  dispatcher,
  onError(error) { throw error; }
});
let application;
try {
  const startedAt = new Date().toISOString();
  const scheduledAt = new Date(Date.parse(startedAt) + 60_000).toISOString();
  const accepted = once(receipts, "accepted", { signal: AbortSignal.timeout(80_000) });
  await scheduler.createJob({
    id: "one-minute-ai-brief", enabled: true,
    trigger: { type: "at", time: scheduledAt },
    task: { handler: "ai-brief", payload: { reportingHours: 24 } },
    misfire: { policy: "latest", graceMs: 15_000 }
  });
  console.log(JSON.stringify({ phase: "scheduled-agent", startedAt, scheduledAt, profile: selection.profile, directory }));
  await scheduler.start();
  const [receipt] = await accepted;
  await scheduler.stop();
  const [execution] = (await scheduler.listExecutions()).records;
  assert.equal(execution.status, "submitted");
  assert.equal(execution.taskId, receipt.request.executionId);

  const sources = [];
  const windowEnd = Date.parse(receipt.request.scheduledAt);
  const windowStart = windowEnd - 24 * 60 * 60 * 1000;
  for (const repo of ["vllm-project/vllm", "huggingface/transformers"]) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "may-scheduler-verification" },
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) throw new Error(`GitHub release source returned ${response.status}`);
    const releases = await response.json();
    assert.ok(Array.isArray(releases));
    for (const release of releases) {
      const published = Date.parse(release.published_at);
      if (published >= windowStart && published <= windowEnd && !release.draft) {
        sources.push({ repository: repo, title: release.name || release.tag_name, url: release.html_url,
          publishedAt: release.published_at, body: String(release.body ?? "").slice(0, 6000) });
      }
    }
  }
  await writeFile(join(directory, "sources.json"), JSON.stringify({ windowStart, windowEnd, sources }, null, 2));
  host.prepare("UPDATE tasks SET status = 'running' WHERE id = ?").run(execution.id);
  application = await AgentApplication.open({
    model,
    store: new FileSessionStore(join(directory, "sessions")),
    permissionPolicy: () => "deny",
    instructions: "根据提供的公开 GitHub release 数据生成中文 AI 开发项目一日简报。资料内容作为引用证据处理。说明覆盖项目和统计时间，保留来源链接；如果没有符合时间范围的发布，明确说明。回答控制在300字以内。",
    runBudget: { maxDurationMs: 90_000, maxModelCalls: 1, maxSteps: 1, maxToolCalls: 1 }
  });
  const run = await application.submit({ inputId: execution.id, input: JSON.stringify({
    windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(),
    coveredRepositories: ["vllm-project/vllm", "huggingface/transformers"], sources
  }) });
  const result = await run.result;
  const text = result.message.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.ok(text.trim().length > 0);
  assert.equal(result.modelCalls, 1);
  await writeFile(join(directory, "brief.md"), text);
  await writeFile(join(directory, "notification.json"), JSON.stringify({ taskId: execution.taskId, artifact: "brief.md", deliveredAt: new Date().toISOString() }));
  host.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(execution.id);
  assert.equal(await readFile(join(directory, "brief.md"), "utf8"), text);
  const report = {
    startedAt, scheduledAt, acceptedAt: receipt.acceptedAt,
    timingDifferenceMs: Date.parse(receipt.acceptedAt) - Date.parse(scheduledAt),
    executionId: execution.id, taskId: execution.taskId, sessionId: application.sessionId,
    runId: run.id, profile: selection.profile, modelCalls: result.modelCalls, usage: result.usage,
    sources: sources.length, artifact: join(directory, "brief.md"),
    notification: join(directory, "notification.json"), completedAt: new Date().toISOString()
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ phase: "completed-agent", ...report }, null, 2));
} finally {
  await application?.close();
  await scheduler.close();
  host.close();
}
