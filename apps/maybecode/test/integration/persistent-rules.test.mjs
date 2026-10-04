import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadMayConfig } from "@may/config";
import { InMemoryContextFactory } from "@may/context";
import { openConfiguredMaybeCode } from "../../dist/index.js";

test("real provider reuses persistent write permission after closing and reopening MaybeCode", {
  skip: process.env.MAYBECODE_PERSISTENT_RULES_LIVE !== "1", timeout: 120_000,
}, async t => {
  const config = await loadMayConfig();
  const profile = process.env.MAYBECODE_PERSISTENT_RULES_MODEL ?? config.defaultModel;
  assert.ok(profile && Object.hasOwn(config.models, profile), "A configured profile is required");
  const base = fileURLToPath(new URL("../../../../review/persistent-rules/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "live-"));
  const workspace = join(directory, "project"), dataDirectory = join(directory, "data");
  await mkdir(workspace);
  const actualFactory = new InMemoryContextFactory(), contexts = [];
  const contextFactory = { create(options) { const managed = actualFactory.create(options); contexts.push(managed.context); return managed; } };
  const options = { git: false, workspace, dataDirectory, autoResume: false, persistentRules: true, permissionMode: "default", model: profile,
    mcp: false, observability: false, skills: false, goals: false, subagents: false, plugins: [], retry: false,
    autoCompactionStrategies: [], providerNativeAutoCompaction: false, contextFactory,
    maxSteps: 3, runBudget: { maxDurationMs: 45_000, maxModelCalls: 3, maxToolCalls: 2 },
    instructions: "Perform precisely the user's requested write with the write tool. Do not use any other tool. After the write succeeds, provide the requested short acknowledgement.",
  };
  const opened = [];
  t.after(async () => { for (const app of opened) await app.close(); });

  const first = await openConfiguredMaybeCode(options); opened.push(first);
  const firstObservation = observe(first, true);
  const firstRun = await first.submit({ input: "Call write exactly once with path persistent.md and content FIRST_RULE_WRITE followed by a newline. After the tool succeeds, reply FIRST_OK. Use write directly." });
  const firstResult = await Promise.race([firstRun.result, firstObservation]);
  const sessionId = first.sessionId;
  const rules = await first.listPermissionRules();
  assert.equal(rules.length, 1);
  const rule = rules[0];
  assert.equal(rule.toolName, "write");
  assert.equal(rule.decision, "allow");
  assert.equal(await readFile(join(workspace, "persistent.md"), "utf8"), "FIRST_RULE_WRITE\n");
  const firstHistory = await first.history();
  assert.equal(firstHistory.filter(event => event.type === "rule.created").length, 1);
  assert.equal(firstHistory.filter(event => event.type === "rule.used").length, 1);
  assert.equal(firstHistory.filter(event => event.type === "approval.resolved" && event.decision === "allow-persistent").length, 1);
  verifyContext(await contexts.at(-1).snapshot(), rule, firstHistory);
  const firstInspection = await first.inspectContext();
  await first.close();
  const firstEvents = await firstObservation;
  assert.equal(firstEvents.filter(event => event.type === "permission.event" && event.event.type === "approval.requested").length, 1);

  const second = await openConfiguredMaybeCode({ ...options, sessionId }); opened.push(second);
  assert.equal(second.sessionId, sessionId);
  assert.deepEqual(await second.listPermissionRules(), [rule]);
  assert.equal((await second.inspectContext()).messageCount, firstInspection.messageCount);
  verifyContext(await contexts.at(-1).snapshot(), rule, await second.history());
  const secondObservation = observe(second, false);
  const secondRun = await second.submit({ input: "Call write exactly once with path persistent.md and content SECOND_RULE_WRITE followed by a newline. Overwrite the same file through write directly. After the tool succeeds, reply SECOND_OK." });
  const secondResult = await Promise.race([secondRun.result, secondObservation]);
  assert.equal(await readFile(join(workspace, "persistent.md"), "utf8"), "SECOND_RULE_WRITE\n");
  const history = await second.history();
  const used = history.filter(event => event.type === "rule.used");
  assert.equal(used.length, 2);
  assert.equal(used.every(event => event.ruleId === rule.id && event.decision === "allow"), true);
  assert.equal(new Set(used.map(event => event.runId)).size, 2);
  assert.equal(history.filter(event => event.type === "approval.requested").length, 1);
  assert.equal(history.filter(event => event.type === "tool.completed" && event.call.name === "write").length, 2);
  assert.equal(history.some(event => event.type === "tool.failed"), false);
  verifyContext(await contexts.at(-1).snapshot(), rule, history);
  await second.close();
  const secondEvents = await secondObservation;
  assert.equal(secondEvents.some(event => event.type === "permission.event" && event.event.type === "approval.requested"), false);
  const modelCalls = [...firstEvents, ...secondEvents].filter(event => event.type === "run.event" && event.event.type === "model.completed");
  const report = { profile, adapter: config.models[profile].adapter ?? config.providers[config.models[profile].provider].adapter, sessionId,
    approvals: [1, 0], writes: 2, rulesCreated: 1, rulesUsed: used.length, modelCalls: modelCalls.length,
    totalTokens: modelCalls.reduce((sum, event) => sum + (event.event.usage?.totalTokens ?? 0), 0),
    contextMessageCount: history.filter(event => ["input.submitted", "assistant.completed", "tool.completed", "tool.failed"].includes(event.type)).length,
    resultSteps: [firstResult.steps, secondResult.steps], evidenceDirectory: directory,
  };
  await writeFile(join(directory, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
  t.diagnostic(JSON.stringify(report));
});

async function observe(app, allowPersistent) {
  const events = [];
  for await (const event of app.events) {
    if (event.type === "permission.event" || event.type === "run.event" && ["model.completed", "tool.completed", "tool.failed"].includes(event.event.type)) events.push(event);
    if (event.type !== "permission.event" || event.event.type !== "approval.requested") continue;
    const request = event.event.request;
    if (!allowPersistent || request.tool.name !== "write" || request.input.path !== "persistent.md" || request.persistent === undefined) {
      await app.resolveApproval(request.id, "deny");
      app.cancel("Unexpected live-test approval");
      assert.fail("The live test received an unexpected approval request");
    }
    assert.equal(await app.resolveApproval(request.id, "allow-persistent", { createdBy: `local:${userInfo().username}` }), true);
  }
  return events;
}

function verifyContext(snapshot, rule, history) {
  const encoded = JSON.stringify(snapshot);
  assert.equal(encoded.includes(rule.id), false, "Rule IDs must stay outside model Context");
  assert.equal(/"type":"(?:rule\.(?:created|used|revoked)|approval\.(?:requested|resolved|cancelled))"/u.test(encoded), false, "Permission evidence must stay outside model Context");
  const conversationEvents = history.filter(event => ["input.submitted", "assistant.completed", "tool.completed", "tool.failed"].includes(event.type));
  assert.equal(snapshot.messages.length, conversationEvents.length);
  assert.equal(snapshot.messages.every(message => ["user", "assistant", "tool"].includes(message.role)), true);
}
