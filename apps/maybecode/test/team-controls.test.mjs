import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { parseMaybeCodeArgs, runMaybeCodeTeamCommand } from "../dist/index.js";

async function fixture(t) {
  const parent = resolve(tmpdir()), directory = await mkdtemp(join(parent, "may-team-controls-"));
  const child = relative(parent, directory); assert.ok(!isAbsolute(child) && !child.startsWith("..") && child.startsWith("may-team-controls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, "source"), dataDirectory = join(directory, "state");
  await mkdir(workspace); await writeFile(join(workspace, "value.txt"), "1");
  const config = { path: join(directory, "config.json"), providers: { fake: { adapter: "openai-responses", apiKey: "private-test-key" } },
    models: { coder: { provider: "fake", model: "code" }, reviewer: { provider: "fake", model: "review" } }, defaultModel: "coder" };
  let text = "";
  return { directory, workspace, dataDirectory, config, write: (value) => { text += value; }, output: () => text, clear: () => { text = ""; },
    id: async () => (await readdir(join(dataDirectory, "teams")))[0] };
}
function response(tool, text = "done") { return { type: "response.completed", usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  message: { role: "assistant", content: tool ? [] : [{ type: "text", text }], ...(tool ? { toolCalls: [{ id: tool.name, ...tool }] } : {}) } }; }
function digest(text) { const value = /Review digest: ([a-f0-9]{64})/u.exec(text)?.[1]; assert.ok(value, text); return value; }

test("configured coding team checks exact edits, separates acceptance, and applies only reviewed conflict-free source bytes", async (t) => {
  const f = await fixture(t), planPath = join(f.directory, "plan.json");
  await writeFile(planPath, JSON.stringify({ format: 1, roles: {
    implementer: { model: "coder", tools: ["read", "edit", "submit_report", "run_check"] },
    reviewer: { model: "reviewer", tools: ["read", "submit_report"] },
  }, tasks: [{ id: "code", agent: "implementer", input: "Set value to 2" }, { id: "summary", agent: "reviewer", input: "Review result", dependsOn: ["code"] }],
  resultTaskId: "summary", checks: [
    { id: "bytes", taskId: "code", type: "file-contains", path: "value.txt", text: "2" },
    { id: "test", taskId: "code", type: "command", command: process.execPath, args: ["-e", "require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'2')"] },
  ] }));
  const profiles = [], dep = { write: f.write, loadConfig: async () => f.config, createModel: (selection) => {
    profiles.push(selection.profile);
    return { async *stream(request) {
      const used = request.messages.flatMap((message) => message.role === "assistant" ? message.toolCalls?.map((call) => call.name) ?? [] : []);
      assert.ok(!request.tools.some((tool) => ["shell", "apply_patch", "reconcile", "retry"].includes(tool.name)));
      const coding = selection.profile === "coder";
      if (!coding) assert.match(JSON.stringify(request.messages), /Host verification record[\s\S]*passed/u);
      if (coding && !used.includes("edit")) yield response({ name: "edit", input: { path: "value.txt", oldText: "1", newText: "2" } });
      else if (coding && !used.includes("run_check")) yield response({ name: "run_check", input: { id: "test" } });
      else if (!used.includes("submit_report")) yield response({ name: "submit_report", input: { summary: "Evidence reviewed", claims: [{ text: "Current value", kind: "finding", evidence: [{ path: "value.txt", startLine: 1, endLine: 1, quote: coding ? "2" : "1" }] }] } });
      else yield response(undefined, "Independent coding result and review.");
    } };
  } };
  const alias = join(f.directory, "data-alias");
  await symlink(f.workspace, alias, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runMaybeCodeTeamCommand({ type: "team", action: "run", value: "test overlap", workspace: f.workspace, dataDirectory: alias }, dep), /outside|overlap/u);
  assert.deepEqual(await readdir(f.workspace), ["value.txt"], "aliased state must not write a manifest into source before rejection");
  assert.equal(await runMaybeCodeTeamCommand(parseMaybeCodeArgs(["team", "run", "Change value", "--plan", planPath, "--mode", "coding", "--allow-checks", "--workspace", f.workspace, "--data-directory", f.dataDirectory]), dep), 0);
  assert.deepEqual(profiles.sort(), ["coder", "reviewer"]);
  assert.match(f.output(), /Acceptance: passed/u);
  assert.equal(await readFile(join(f.workspace, "value.txt"), "utf8"), "1");
  const id = await f.id(), control = { write: f.write, loadConfig: async () => { throw new Error("Control must not require model config"); }, createModel: () => { throw new Error("Control must not construct model"); } };
  const manifestPath = join(f.dataDirectory, "teams", id, "manifest.json"), original = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), allowChecks: false }));
  await assert.rejects(runMaybeCodeTeamCommand({ type: "team", action: "resume", value: id, dataDirectory: f.dataDirectory }, dep), /policy version changed/u);
  await writeFile(manifestPath, original);
  assert.equal(profiles.length, 2, "manifest authority drift must not start another model");
  // Changing the plan file after creation never changes the persisted authorities or graph.
  await writeFile(planPath, "invalid changed plan");
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "verify", value: id, dataDirectory: f.dataDirectory }, control), 0);
  f.clear();
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "diff", value: id, tasks: "code", dataDirectory: f.dataDirectory }, control), 0);
  const confirmation = digest(f.output()), patch = `patch-${confirmation}`;
  assert.match(f.output(), /-1/u); assert.match(f.output(), /\+2/u);
  const apply = { type: "team", action: "apply", value: id, dataDirectory: f.dataDirectory, patch, confirm: confirmation };
  await writeFile(join(f.workspace, "value.txt"), "concurrent edit");
  await assert.rejects(runMaybeCodeTeamCommand(apply, control), /changed|conflict|match/iu);
  assert.equal(await readFile(join(f.workspace, "value.txt"), "utf8"), "concurrent edit");
  await writeFile(join(f.workspace, "value.txt"), "1");
  assert.equal(await runMaybeCodeTeamCommand(apply, control), 0);
  assert.equal(await readFile(join(f.workspace, "value.txt"), "utf8"), "2");
  assert.equal(await runMaybeCodeTeamCommand(apply, control), 0, "an acknowledged application is not replayed");
});

test("host verification consumes terminal cancellation and requires explicit unknown-effect reconciliation", async (t) => {
  const f = await fixture(t), planPath = join(f.directory, "plan.json");
  await writeFile(planPath, JSON.stringify({ format: 1, roles: { worker: { tools: ["submit_report"] } },
    tasks: [{ id: "work", agent: "worker", input: "Report source" }], resultTaskId: "work",
    checks: [{ id: "slow", taskId: "work", type: "command", command: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }] }));
  let calls = 0;
  const dep = { write: f.write, loadConfig: async () => f.config, createModel: () => ({ async *stream(request) {
    calls++; yield request.messages.some((message) => message.role === "tool") ? response() : response({ name: "submit_report", input: { summary: "Source inspected", claims: [] } });
  } }) };
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "run", value: "report", planPath, workspace: f.workspace, dataDirectory: f.dataDirectory, allowChecks: true }, dep), 1, "command checks do not automatically run at task completion");
  const id = await f.id(), base = { type: "team", value: id, dataDirectory: f.dataDirectory }, directory = join(f.dataDirectory, "teams", id);
  const verifying = runMaybeCodeTeamCommand({ ...base, action: "verify" }, dep);
  // Observe durable pending evidence rather than guessing when the child process starts.
  for (let i = 0; i < 100; i++) {
    if ((await readFile(join(directory, "verification", "verification.jsonl"), "utf8")).includes('"status":"pending"')) break;
    await setTimeout(10);
  }
  await runMaybeCodeTeamCommand({ ...base, action: "cancel" }, dep);
  assert.equal(await verifying, 1);
  f.clear(); await runMaybeCodeTeamCommand({ ...base, action: "status" }, dep);
  const commandId = /Check slow \(work\): unknown; command ([^;\s]+)/u.exec(f.output())?.[1]; assert.ok(commandId, f.output());
  assert.equal(await runMaybeCodeTeamCommand({ ...base, action: "resume" }, dep), 1);
  assert.equal(calls, 2, "unknown external check effects do not restart completed agents");
  const resolutionPath = join(f.directory, "check-resolution.json");
  await writeFile(resolutionPath, JSON.stringify({ format: 1, kind: "check", commandId, outcome: "cancelled", finding: "Owned test process stopped; this fixture spawned no child processes." }));
  const reconcile = { ...base, action: "reconcile", resolutionPath };
  f.clear(); await runMaybeCodeTeamCommand(reconcile, dep);
  await runMaybeCodeTeamCommand({ ...reconcile, confirm: digest(f.output()) }, dep);
  assert.equal(await runMaybeCodeTeamCommand({ ...base, action: "verify" }, dep), 1, "cancelled checks are not accepted and cancellation is not silently cleared");
});

test("recovery CLI previews exact effects, reconciles one budget call, and queues explicit attempts without cascading or replay", async (t) => {
  const f = await fixture(t), planPath = join(f.directory, "plan.json");
  await writeFile(planPath, JSON.stringify({ format: 1, roles: { worker: { tools: ["read"] } },
    tasks: [{ id: "first", agent: "worker", input: "first" }, { id: "last", agent: "worker", input: "last", dependsOn: ["first"] }], resultTaskId: "last" }));
  let calls = 0, fail = true;
  const dep = { write: f.write, loadConfig: async () => f.config, createModel: () => ({ async *stream() {
    calls++; if (fail) throw new Error("Offline transport outcome unknown"); yield response();
  } }) };
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "run", value: "test recovery", planPath, workspace: f.workspace, dataDirectory: f.dataDirectory }, dep), 1);
  const id = await f.id(), directory = join(f.dataDirectory, "teams", id), control = { write: f.write, loadConfig: async () => { throw new Error("No config for recovery"); } };
  f.clear(); await runMaybeCodeTeamCommand({ type: "team", action: "status", value: id, dataDirectory: f.dataDirectory }, control);
  assert.match(f.output(), /Offline transport outcome unknown/u); assert.match(f.output(), /Budget call .+: unknown/u);
  assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "resume", value: id, dataDirectory: f.dataDirectory }, dep), 1);
  assert.equal(calls, 1, "unknown budget prevents all new Runs");
  const budgetFile = (await readdir(join(directory, "budget"))).find((name) => name.endsWith(".jsonl"));
  const budget = JSON.parse((await readFile(join(directory, "budget", budgetFile), "utf8")).trim().split("\n").at(-1));
  const resolutionPath = join(f.directory, "resolution.json");
  await writeFile(resolutionPath, JSON.stringify({ format: 1, kind: "budget", callId: budget.calls[0].id, usage: { totalTokens: 0 }, finding: "Offline mock threw before provider execution; verified zero usage." }));
  const reconcile = { type: "team", action: "reconcile", value: id, dataDirectory: f.dataDirectory, resolutionPath };
  f.clear(); await runMaybeCodeTeamCommand(reconcile, control); const confirmation = digest(f.output());
  await assert.rejects(runMaybeCodeTeamCommand({ ...reconcile, confirm: "0".repeat(64) }, control), /digest/iu);
  await runMaybeCodeTeamCommand({ ...reconcile, confirm: confirmation }, control);
  assert.equal(calls, 1);
  fail = false;
  for (const task of ["first", "last"]) {
    const retry = { type: "team", action: "retry", value: id, dataDirectory: f.dataDirectory, task, finding: "Known failed offline attempt; explicitly authorize a fresh attempt." };
    f.clear(); await runMaybeCodeTeamCommand(retry, control);
    if (task === "first") assert.match(f.output(), /affectedDependants[\s\S]*last/u);
    const before = calls;
    await runMaybeCodeTeamCommand({ ...retry, confirm: digest(f.output()) }, control);
    assert.equal(calls, before, "retry queues only; it cannot execute or reset budgets");
    assert.equal(await runMaybeCodeTeamCommand({ type: "team", action: "resume", value: id, dataDirectory: f.dataDirectory }, dep), task === "first" ? 1 : 0, f.output());
  }
  assert.equal(calls, 3);
  assert.match(f.output(), /Acceptance: unverified/u);
  assert.throws(() => parseMaybeCodeArgs(["team", "apply", id, "--patch", "patch-x"]), /confirm/u);
  await writeFile(resolutionPath, JSON.stringify({ format: 1, kind: "task", taskId: "first", outcome: "completed", finding: "Cannot invent success" }));
  await assert.rejects(runMaybeCodeTeamCommand(reconcile, control), /manufacture/iu);
});
