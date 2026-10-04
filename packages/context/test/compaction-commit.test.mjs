import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { HistoryReferenceStrategy, InMemoryContextFactory, PruneOldToolResultsStrategy } from "../dist/index.js";

const output = fileURLToPath(new URL("../.test-output/", import.meta.url));
const source = fileURLToPath(new URL("../../../AGENTS.md", import.meta.url));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function fixture(t) {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "commit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages = [
    { role: "user", content: [{ type: "text", text: "读取仓库指令" }] },
    { role: "assistant", content: [], toolCalls: [{ id: "verification.read", name: "read_file", input: { path: source } }] },
    { role: "tool", toolCallId: "verification.read", name: "read_file", content: [{ type: "text", text: await readFile(source, "utf8") }] },
  ];
  const managed = new InMemoryContextFactory().create({
    messages,
    measurement: { inputTokens: 5000, contextMessageCount: messages.length },
    compactionStrategy: new PruneOldToolResultsStrategy({ keepRecentToolResults: 0, minimumResultBytes: 1 }),
  });
  return { directory, messages, managed };
}

test("直接使用 ContextController 保存成功后提交替换状态并保留后续消息", async t => {
  const { directory, managed } = await fixture(t);
  const result = await managed.controller.compact();
  const file = join(directory, "context.json");
  await writeFile(file, JSON.stringify(result.messages));
  managed.controller.commitCompaction(result);
  managed.controller.commitCompaction(result);
  const followup = { role: "user", content: [{ type: "text", text: "继续处理请求" }] };
  await managed.context.append([followup]);
  await managed.controller.rollbackCompaction(result);
  assert.deepEqual((await managed.context.snapshot()).messages, [...JSON.parse(await readFile(file, "utf8")), followup]);
  assert.equal((await managed.controller.inspect()).measurementMethod, "estimated");
});

test("直接使用 ContextController 保存失败后恢复原消息与 measurement", async t => {
  const { directory, messages, managed } = await fixture(t);
  const result = await managed.controller.compact();
  await assert.rejects(writeFile(directory, JSON.stringify(result.messages)), error => error.code === "EISDIR" || error.code === "EPERM");
  const followup = { role: "user", content: [{ type: "text", text: "继续处理请求" }] };
  await managed.context.append([followup]);
  await managed.controller.rollbackCompaction(result);
  assert.deepEqual((await managed.context.snapshot()).messages, [...messages, followup]);
  assert.equal((await managed.controller.inspect()).measuredInputTokens, 5000);
});

test("已经提交的延后压缩请求在通知失败后完成", async t => {
  const { directory, messages } = await fixture(t);
  const managed = new InMemoryContextFactory().create({
    messages: [...messages, { role: "user", content: [{ type: "text", text: "继续读取文件" }] }],
  });
  const strategy = new HistoryReferenceStrategy({ reference: "历史保存在验证文件中" });
  const failure = new Error("完成通知失败");
  let notifications = 0;
  managed.controller.setAutoCompactionSink(async result => {
    await writeFile(join(directory, "context.json"), JSON.stringify(result.messages));
    managed.controller.commitCompaction(result);
    notifications++;
    throw failure;
  });
  managed.controller.requestCompaction(strategy);
  await assert.rejects(managed.context.snapshot(), error => error === failure);
  const followup = { role: "user", content: [{ type: "text", text: "保留当前请求并继续处理" }] };
  await managed.context.append([followup]);
  const snapshot = await managed.context.snapshot();
  assert.equal(snapshot.messages.filter(message => message.role === "user").length, 2);
  assert.equal(notifications, 1);
});

for (const phase of ["strategy", "persistence"]) {
  test(`${phase} 等待期间到达的相同 strategy 请求继续保留`, async t => {
    const { directory, messages } = await fixture(t);
    const entered = deferred();
    const release = deferred();
    t.after(() => release.resolve());
    const managed = new InMemoryContextFactory().create({
      messages: [...messages, { role: "user", content: [{ type: "text", text: "继续读取文件" }] }],
    });
    let references = 0;
    const strategy = new HistoryReferenceStrategy({
      async reference() {
        references++;
        if (phase === "strategy" && references === 1) { entered.resolve(); await release.promise; }
        await readFile(source, "utf8");
        return "历史保存在验证文件中";
      },
    });
    let saved = 0;
    managed.controller.setAutoCompactionSink(async result => {
      saved++;
      if (phase === "persistence" && saved === 1) { entered.resolve(); await release.promise; }
      await writeFile(join(directory, "context.json"), JSON.stringify(result.messages));
      managed.controller.commitCompaction(result);
    });
    managed.controller.requestCompaction(strategy);
    const first = managed.context.snapshot();
    await entered.promise;
    managed.controller.requestCompaction(strategy);
    release.resolve();
    await first;
    await managed.context.append([{ role: "user", content: [{ type: "text", text: "按照新请求再次整理历史" }] }]);
    const snapshot = await managed.context.snapshot();
    assert.equal(snapshot.messages.filter(message => message.role === "user").length, 1);
    assert.equal(references, 2);
    assert.equal(saved, 2);
  });
}
