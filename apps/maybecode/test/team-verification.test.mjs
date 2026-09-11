import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamVerificationStore, parseTeamChecks, parseTeamReport } from "../dist/team-verification.js";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "may-team-verification-"));
  const stores = []; t.after(async () => { for (const store of stores) await store.close(); await rm(directory, { recursive: true, force: true }); });
  const workspace = join(directory, "workspace"); const state = join(directory, "state");
  await mkdir(workspace); await writeFile(join(workspace, "sum.mjs"), "export const sum = (a, b) => a + b;\n");
  return { directory, workspace, state, track: (store) => { stores.push(store); return store; } };
}
const execution = { coordinationId: "team", task: { id: "analysis", dispatchId: "dispatch", turn: 0 } };
const report = { summary: "The implementation adds two values.", claims: [
  { text: "Uses addition", kind: "finding", evidence: [{ path: "sum.mjs", startLine: 1, endLine: 1, quote: "a + b" }] },
] };

test("acceptance is host-check scoped, dispatch bound, and invalidated by any workspace change", async (t) => {
  const { workspace, state, track } = await fixture(t);
  const spec = { id: "adds", taskId: "analysis", type: "file-contains", path: "sum.mjs", text: "a + b" };
  const store = track(await TeamVerificationStore.open({ directory: state, checks: [spec] }));
  const scoped = store.forTask(execution, workspace);
  const stored = await scoped.submit("report-1", report);
  assert.equal(stored.evidence[0].valid, true);
  assert.equal((await store.acceptance("analysis", workspace, execution)).status, "unverified");
  const checked = await scoped.runCheck("check-1", "adds");
  assert.equal(checked.status, "passed");
  assert.equal((await store.acceptance("analysis", workspace, execution)).status, "passed");
  assert.deepEqual(await scoped.submit("report-1", report), stored);
  await assert.rejects(scoped.submit("report-1", { ...report, summary: "Changed" }), /already used/u);
  assert.equal((await store.acceptance("analysis", workspace, { ...execution, task: { ...execution.task, dispatchId: "retry" } })).status, "unverified");
  await writeFile(join(workspace, "new.test.mjs"), "// unrelated change also invalidates a green check\n");
  const stale = await store.acceptance("analysis", workspace, execution);
  assert.equal(stale.status, "unverified"); assert.equal(stale.checks[0].status, "stale");
  await scoped.submit("report-2", { ...report, claims: [{ text: "Bad citation", kind: "finding", evidence: [{ path: "sum.mjs", startLine: 99, endLine: 99 }] }] });
  assert.equal((await store.acceptance("analysis", workspace)).status, "failed");
  assert.throws(() => parseTeamReport({ ...report, verified: true }), /Invalid verification fields/u);
  assert.throws(() => parseTeamChecks([{ ...spec, path: "../outside" }]), /Unsafe/u);
});

test("command checks require exact host authorization, scrub credentials, and never replay recovered pending effects", async (t) => {
  const { workspace, state, directory, track } = await fixture(t);
  const counter = join(directory, "calls.txt");
  const secretName = "MAY_VERIFICATION_TEST_SECRET";
  process.env[secretName] = "must-not-inherit"; t.after(() => { delete process.env[secretName]; });
  const spec = { id: "node-check", taskId: "analysis", type: "command", command: process.execPath, args: ["-e",
    `require('node:fs').appendFileSync(${JSON.stringify(counter)}, 'called\\n'); if (process.env.${secretName}) process.exit(9); console.log('checked');`] };
  let store = track(await TeamVerificationStore.open({ directory: state, checks: [spec] }));
  await assert.rejects(store.runCheck("denied", spec, workspace), /allow-checks/u);
  await assert.rejects(store.runCheck("altered", { ...spec, args: ["-e", "process.exit(0)"] }, workspace, { allowCommands: true }), /exact host/u);
  const done = await store.runCheck("command-1", spec, workspace, { allowCommands: true });
  assert.equal(done.status, "passed"); assert.equal(done.exitCode, 0); assert.equal(done.output.trim(), "checked");
  assert.deepEqual(await store.runCheck("command-1", spec, workspace), done);
  assert.equal((await TeamVerificationStore.inspect(state)).checks[0].status, "passed");
  await store.close();
  // Simulate durable pending intent with the terminal write missing after a crash.
  const journal = join(state, "verification.jsonl");
  const lines = (await readFile(journal, "utf8")).trimEnd().split("\n");
  await writeFile(journal, `${lines.slice(0, -1).join("\n")}\n{"sequence":`);
  assert.equal((await TeamVerificationStore.inspect(state)).checks[0].status, "pending", "monitoring ignores but never repairs a partial tail");
  store = track(await TeamVerificationStore.open({ directory: state, checks: [spec] }));
  assert.equal((await store.snapshot()).checks[0].status, "unknown");
  assert.equal((await store.runCheck("command-1", spec, workspace, { allowCommands: true })).status, "unknown");
  await assert.rejects(store.runCheck("command-2", spec, workspace, { allowCommands: true }), /unknown check/u);
  assert.equal(await readFile(counter, "utf8"), "called\n", "recovery and repeated identity must not launch another process");
  await assert.rejects(store.reconcile("command-1", { status: "passed" }, "I inspected the result"), /cannot grant/u);
  await store.reconcile("command-1", { status: "failed" }, "Inspected effects; explicit fresh verification is required.");
  assert.equal((await store.runCheck("command-2", spec, workspace, { allowCommands: true })).status, "passed");
  assert.equal(await readFile(counter, "utf8"), "called\ncalled\n");
});

test("bounded commands fail closed on oversized output and mutations cannot preserve acceptance", async (t) => {
  const { workspace, state, track } = await fixture(t);
  const specs = [
    { id: "mutates", taskId: "analysis", type: "command", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('new.txt', 'created')"] },
    { id: "noisy", taskId: "analysis", type: "command", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(8192)); setInterval(()=>{}, 1000)"], maxOutputBytes: 32, timeoutMs: 2000 },
  ];
  const store = track(await TeamVerificationStore.open({ directory: state, checks: specs }));
  await store.forTask(execution, workspace).submit("report", report);
  const mutation = await store.runCheck("mutation", specs[0], workspace, { allowCommands: true });
  assert.equal(mutation.status, "passed"); assert.notEqual(mutation.workspaceFingerprint, mutation.afterFingerprint);
  assert.equal((await store.acceptance("analysis", workspace)).checks[0].status, "stale");
  const noisy = await store.runCheck("noisy", specs[1], workspace, { allowCommands: true });
  assert.equal(noisy.status, "unknown"); assert.equal(Buffer.byteLength(noisy.output), 32);
  assert.match(noisy.detail, /output limit/u);
});
