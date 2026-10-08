import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryContextFactory, PruneOldToolResultsStrategy } from "@may/context";
import { HistoryReferenceMemory, createHistoryMemoryPlugin, historyMemoryService } from "../dist/index.js";
import { PluginHost } from "@may/plugin";
import { APPLICATION_HOOKS, AgentApplication, applicationServices } from "@may/application";
import { DeepSeekModel } from "../../../providers/deepseek/dist/index.js";
import { InMemorySessionStore } from "../../../session/dist/index.js";

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

test("direct history composition and ordered instruction sources provide the same guidance without repetition", async () => {
  const memory = new HistoryReferenceMemory(true);
  const factory = new InMemoryContextFactory();
  const direct = await memory.wrap(factory).create({ instructions: "Inspect the source." });
  const source = () => ["Inspect the source.", memory.instructions()].join("\n\n");
  const ordered = await memory.wrap(factory, { includeInstructions: false }).create({ instructionsSource: source });
  const first = await direct.context.snapshot();
  const second = await ordered.context.snapshot();
  assert.equal(first.instructions, second.instructions);
  assert.equal(second.instructions.match(/# Context continuity/gu).length, 1);
  assert.equal(new HistoryReferenceMemory(false).instructions(), "");
});

for (const [label, options, active] of [
  ["history-reference", { mode: "history-reference" }, true],
  ["prune-summary", { mode: "prune-summary" }, false],
  ["explicit automatic strategies", { mode: "history-reference", autoCompactionStrategies: [new PruneOldToolResultsStrategy()] }, false],
]) {
  test(`${label} mode contributes only its applicable history guidance`, async t => {
    const application = await AgentApplication.open({
      model: new DeepSeekModel({ apiKey: "unused-before-provider-dispatch", model: "deepseek-chat" }),
      store: new InMemorySessionStore(), instructions: "Inspect the source.",
      plugins: [createHistoryMemoryPlugin(options)],
    });
    t.after(() => application.close());
    const instructions = application.getService(applicationServices.instructionSources).snapshot();
    assert.equal(instructions.includes("# Context continuity"), active);
    assert.equal(application.getService(historyMemoryService).memory.instructions() !== "", active);
    assert.equal(application.getService(applicationServices.toolSources).snapshot().get("new_context") !== undefined, active);
  });
}
