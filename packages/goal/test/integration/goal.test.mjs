import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GoalController } from "../../dist/index.js";
import { AgentApplication } from "../../../application/dist/index.js";
import { loadMayConfig } from "../../../config/dist/index.js";
import { InMemoryContextFactory, PruneOldToolResultsStrategy } from "../../../context/dist/index.js";
import { createModelContextSummarizer } from "../../../context/dist/model-summarizer.js";
import { createBuiltinProviderModel, selectProviderModel } from "../../../providers/dist/index.js";
import { FileSessionStore } from "../../../session/dist/file-store.js";
import { createCodingTools } from "../../../tools/coding-tools/dist/index.js";

test("independent goal composition verifies real reads across compaction and meters auxiliary model calls", { timeout: 90_000 }, async t => {
  const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
  const parent = join(workspace, "review", "goal-sdk-tests");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, "session-"));
  const heading = (await readFile(join(workspace, "README.md"), "utf8")).split(/\r?\n/u).find(line => line.startsWith("# ")).slice(2).trim();
  let application;
  let compacted = false;
  let summarized = false;
  const goal = new GoalController({ verify: async (state, signal) => {
    const history = await application.history();
    const reads = history.filter(event => event.type === "tool.completed" && event.call.name === "read" && event.call.input.path === "README.md");
    if (new Set(reads.map(event => event.runId)).size >= 2 && state.report.evidence.includes(heading)) return { completed: true, evidence: `Verified ${heading} against README.md and two independently recorded read runs.` };
    const result = await application.compactContext(new PruneOldToolResultsStrategy({ keepRecentToolResults: 0, minimumResultBytes: 0 }));
    compacted ||= result.changed;
    const before = goal.getGoal().usage.totalTokens;
    const summary = await summarizer.summarize({ messages: [{ role: "user", content: [{ type: "text", text: state.objective }] }, { role: "assistant", content: [{ type: "text", text: state.report.evidence }] }], signal });
    summarized ||= goal.getGoal().usage.totalTokens > before;
    return { completed: false, evidence: `A second read of README.md in a new run is required. Read the first 3 lines again and report the heading. Recorded summary: ${summary}` };
  } });
  const model = goal.wrapModel(createBuiltinProviderModel(selectProviderModel(await loadMayConfig(), { model: "deepseek-v4-flash" })));
  const summarizer = createModelContextSummarizer(model, { instructions: "Summarize the stated objective and reported result in one short sentence.", requestText: "Return the summary." });
  application = await AgentApplication.open({ model, store: new FileSessionStore(directory),
    tools: createCodingTools({ cwd: workspace }).filter(tool => tool.name === "read"),
    toolSource: () => goal.tools(), permissionPolicy: () => "allow", contextFactory: goal.wrapContextFactory(new InMemoryContextFactory()) });
  const relay = (async () => { for await (const _event of application.events) {} })();
  t.after(async () => { await goal.close(); await application.close(); await relay; });
  await goal.attach(application, {
    read: async () => {
      const event = [...await application.history()].reverse().find(event => event.type === "state.updated" && event.key === "test.goal");
      return event?.value;
    },
    write: state => application.recordState("test.goal", state),
  });
  await goal.start("Read the first three lines of README.md and report the first heading through update_goal completed. Follow the verifier's progress instructions for additional checks.", { maxRuns: 4, maxTotalTokens: 60000 });
  await goal.wait();
  assert.equal(goal.getGoal().status, "completed", JSON.stringify(goal.getGoal()));
  assert.equal(goal.getGoal().completion.source, "verifier");
  assert.ok(compacted);
  assert.ok(summarized);
  assert.ok(goal.getGoal().calls.some(call => call.runId === undefined && call.status === "settled"));
  assert.equal((await application.history()).filter(event => event.type === "input.submitted").length, 1);
});
