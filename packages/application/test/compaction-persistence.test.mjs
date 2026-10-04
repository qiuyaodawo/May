import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AgentApplication, applicationHooks } from "../dist/index.js";
import { May, userMessage } from "../../core/dist/index.js";
import { PruneOldToolResultsStrategy } from "../../context/dist/index.js";
import { definePlugin } from "../../plugin/dist/index.js";
import { createRuntimePlugin } from "../../plugins/runtime/dist/index.js";
import { OpenAIResponsesModel } from "@may/provider-openai";
import { FileSessionStore } from "../../session/dist/file-store.js";

const output = fileURLToPath(new URL("../.test-output/", import.meta.url));
const source = fileURLToPath(new URL("../../../AGENTS.md", import.meta.url));

async function openApplication(t, automatic, completion) {
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(join(output, "compaction-"));
  const store = new FileSessionStore(join(directory, "sessions"));
  const strategy = new PruneOldToolResultsStrategy({ keepRecentToolResults: 0, minimumResultBytes: 1 });
  let context;
  const options = {
    sessionId: `verification-${crypto.randomUUID()}`,
    store,
    model: new OpenAIResponsesModel({ apiKey: "context-verification-local-only", model: "context-verification-local-only" }),
    contextBudget: { contextWindowTokens: 1000, compactTriggerRatio: 0.5 },
    compactionStrategy: strategy,
    ...(automatic ? { autoCompactionStrategies: [strategy] } : {}),
    plugins: [
      createRuntimePlugin(input => { context = input.context; return new May(input); }),
      definePlugin({
        id: "verification.compaction-notification", version: "1.0.0",
        requiresHooks: [applicationHooks.compactionCompleted],
        setup(pluginContext) { pluginContext.on(applicationHooks.compactionCompleted, completion); },
      }),
    ],
  };
  const application = await AgentApplication.open(options);
  t.after(async () => { await application.close(); await rm(directory, { recursive: true, force: true }); });
  await context.append([
    userMessage("读取仓库指令"),
    { role: "assistant", content: [], toolCalls: [{ id: "verification.read", name: "read_file", input: { path: source } }] },
    { role: "tool", name: "read_file", toolCallId: "verification.read", content: [{ type: "text", text: await readFile(source, "utf8") }] },
  ]);
  return { application, options, store, directory, compact: () => automatic ? context.snapshot() : application.compactContext() };
}

for (const automatic of [false, true]) {
  const mode = automatic ? "自动" : "手动";
  test(`${mode}压缩在完成 Hook 失败后保留已经保存的 Context`, async t => {
    const failure = new Error("完成通知失败");
    const { application, options, compact } = await openApplication(t, automatic, () => { throw failure; });
    const before = await application.inspectContext();
    await assert.rejects(compact(), error => error === failure);
    const after = await application.inspectContext();
    assert(after.messageBytes < before.messageBytes);
    const saved = (await application.history()).find(event => event.type === "context.compacted");
    assert(saved);
    assert.equal(saved.messages.at(-1).content[0].type, "text");
    assert.match(saved.messages.at(-1).content[0].text, /tool result pruned/u);
    await application.close();
    const resumed = await AgentApplication.open({ ...options, resume: true });
    try { assert.deepEqual(await resumed.inspectContext(), after); }
    finally { await resumed.close(); }
  });

  test(`${mode}压缩在真实文件保存失败后恢复 Context`, async t => {
    let notifications = 0;
    const { application, store, directory, compact } = await openApplication(t, automatic, () => { notifications++; });
    const before = await application.inspectContext();
    const files = await readdir(store.directory);
    assert.equal(files.length, 1);
    const journal = join(store.directory, files[0]);
    const backup = join(directory, "saved-history.jsonl");
    await rename(journal, backup);
    await mkdir(journal);
    try {
      await assert.rejects(compact(), error => error.code === "EISDIR" || error.code === "EPERM");
      assert.deepEqual(await application.inspectContext(), before);
      assert.equal(notifications, 0);
    } finally {
      await rm(journal, { recursive: true });
      await rename(backup, journal);
    }
    assert.equal((await application.history()).some(event => event.type === "context.compacted"), false);
  });
}
