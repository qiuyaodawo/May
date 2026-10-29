import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { defineAgent } from "@sortedyuan/may";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { OpenAIResponsesModel } from "@sortedyuan/providers/openai";
import { createMayAgentAdapter } from "../../dist/adapters/index.js";

test("May adapter owns its execution context during history inspection and releases failed attempts", async t => {
  const base = fileURLToPath(new URL("../../../../review/gateway-execution-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "conversation-"));
  const store = new FileSessionStore(directory);
  let currentContext;
  const adapter = createMayAgentAdapter({
    agentId: "execution-owner",
    store,
    definition: (tools, context) => {
      currentContext = context;
      return defineAgent({
        model: new OpenAIResponsesModel({ apiKey: "unused-cancelled-execution", model: "unused-cancelled-execution" }),
        toolSource: tools,
      });
    },
  });
  const executions = [];
  t.after(async () => {
    await Promise.all(executions);
    await adapter.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const conversationId = await adapter.createConversation("concurrent-inputs");
  const cancelled = new Error("Execution cancelled before model access");
  const context = inputId => ({
    conversationId, inputId,
    input: { role: "user", content: [{ type: "text", text: inputId }] },
    signal: AbortSignal.abort(cancelled), tools: [], shouldYield: () => false,
    report() {},
  });
  const first = context("first-input");
  const firstRejected = assert.rejects(adapter.execute(first), error => error === cancelled);
  executions.push(firstRejected);
  await Promise.resolve();
  assert.equal(currentContext(), first);
  await assert.rejects(adapter.execute(context("second-input")), /对话正在执行/);
  assert.equal(currentContext(), first);
  await firstRejected;
  assert.equal(currentContext(), undefined);
  assert.equal((await store.inspect(conversationId)).some(event => event.type === "input.submitted"), false);

  const journal = join(directory, `${Buffer.from(conversationId).toString("base64url")}.jsonl`);
  const saved = await readFile(journal);
  await writeFile(journal, "invalid-json\n");
  await assert.rejects(adapter.execute(context("inspection-failure")), /Invalid session event JSON/);
  assert.equal(currentContext(), undefined);
  await writeFile(journal, saved);
  await assert.rejects(adapter.execute(context("after-repair")), error => error === cancelled);
  assert.equal(currentContext(), undefined);
  await adapter.release(conversationId);
});
