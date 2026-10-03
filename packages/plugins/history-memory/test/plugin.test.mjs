import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryContextFactory } from "@may/context";
import { HistoryReferenceMemory, createHistoryMemoryPlugin } from "../dist/index.js";
import { PluginHost } from "@may/plugin";
import { APPLICATION_HOOKS } from "@may/application";

test("history memory reports the actual Context capacity from the attached controller", async () => {
  const memory = new HistoryReferenceMemory(false);
  const managed = await memory.wrap(new InMemoryContextFactory()).create({
    instructions: "Read the supplied files.", messages: [],
    budget: { contextWindowTokens: 1000, outputReserveTokens: 100 },
  });
  await managed.context.append([{ role: "user", content: [{ type: "text", text: "Review README.md" }] }]);
  const tool = memory.tools().find(value => value.name === "get_context_remaining");
  const result = await tool.execute(tool.parse({}), { signal: new AbortController().signal });
  assert.ok(result.usedTokens > 0);
  assert.equal(result.contextWindowTokens, 1000);
  assert.ok(result.remainingInputTokens < 900);
  memory.cancelRequest();
});

test("history memory refuses a composition missing application services", async () => {
  await assert.rejects(PluginHost.create({ plugins: [createHistoryMemoryPlugin()], hooks: APPLICATION_HOOKS }), /requires missing service/u);
});
