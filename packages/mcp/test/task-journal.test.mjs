import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryMcpCredentialStore, KeyringMcpCredentialStore, McpTaskJournal, parseMcpTask } from "../dist/index.js";

const owner = { workspaceId: "workspace-A", sessionId: "session-A", runId: "run-A", toolCallId: "call-A" };
const binding = { serverId: "remote", protocolVersion: "2026-07-28", endpointIdentity: "a".repeat(64), toolName: "slow", toolDefinitionHash: "b".repeat(64) };
const seed = { resultType: "task", taskId: "remote-task", status: "working", createdAt: "2026-09-06T00:00:00Z", lastUpdatedAt: "2026-09-06T00:00:00Z", ttlMs: 600_000, pollIntervalMs: 1000 };
const pending = { ...seed, resultType: "complete", status: "input_required", inputRequests: { privateKey: { method: "sampling/createMessage", params: { maxTokens: 4096, messages: [{ role: "user", content: { type: "text", text: "sensitive server prompt" } }] } } } };

test("task journal binds ownership across restart, claims inputs exactly once and preserves cancellation uncertainty", async () => {
  const store = new InMemoryMcpCredentialStore();
  let journal = new McpTaskJournal(store);
  const initial = await journal.begin(owner, binding);
  assert.equal(initial.status, "starting"); assert.ok(Object.isFrozen(initial.owner));
  await assert.rejects(journal.observe(initial.id, owner, binding, pending, "state"), /unbound/u);
  await journal.observe(initial.id, owner, binding, seed, "created");
  journal = new McpTaskJournal(store);
  assert.equal((await journal.get(initial.id, owner, binding)).remote.taskId, seed.taskId);
  await assert.rejects(journal.get(initial.id, { ...owner, sessionId: "other" }, binding), /not owned/u);
  await assert.rejects(journal.get(initial.id, owner, { ...binding, endpointIdentity: "c".repeat(64) }), /not owned/u);
  await assert.rejects(journal.get(initial.id, owner, { ...binding, toolDefinitionHash: "c".repeat(64) }), /not owned/u);

  const otherOwner = { ...owner, sessionId: "other" };
  const other = await journal.begin(otherOwner, binding);
  await assert.rejects(journal.observe(other.id, otherOwner, binding, seed, "created"), /another Session/u);
  await journal.uncertain(other.id, otherOwner, binding);
  assert.equal((await new McpTaskJournal(store).list(otherOwner))[0].status, "uncertain");
  assert.equal((await journal.list(owner)).length, 1);
  await journal.observe(initial.id, owner, binding, pending, "state");
  const [first, duplicate] = await Promise.all([1, 2].map(() => journal.claimInput(initial.id, owner, binding, "privateKey", pending.inputRequests.privateKey)));
  assert.ok(first.claim); assert.equal(duplicate.claim, undefined);
  await assert.rejects(journal.claimInput(initial.id, owner, binding, "privateKey", { method: "roots/list" }), /reused/u);
  const reordered = { params: pending.inputRequests.privateKey.params, method: "sampling/createMessage" };
  assert.equal((await new McpTaskJournal(store).claimInput(initial.id, owner, binding, "privateKey", reordered)).claim, undefined);
  await journal.reserveSampling(initial.id, owner, binding, first.claim.id, 4096);
  await assert.rejects(journal.reserveSampling(initial.id, owner, binding, first.claim.id, 4096), /unreserved/u);
  await journal.markInput(initial.id, owner, binding, first.claim.id, "submitted");
  await journal.markInput(initial.id, owner, binding, first.claim.id, "acknowledged");
  for (let i = 1; i < 5; i++) {
    const next = await journal.claimInput(initial.id, owner, binding, `sampling-${i}`, pending.inputRequests.privateKey);
    if (i === 4) await assert.rejects(journal.reserveSampling(initial.id, owner, binding, next.claim.id, 1), /budget exceeded/u);
    else await journal.reserveSampling(initial.id, owner, binding, next.claim.id, 4096);
  }
  const bounded = await journal.get(initial.id, owner, binding);
  assert.equal(bounded.samplingCalls, 4); assert.equal(bounded.samplingTokens, 16_384);
  const persisted = JSON.stringify(await journal.list(owner));
  assert.doesNotMatch(persisted, /privateKey|sensitive server prompt|inputRequests/u);
  await journal.cancelIntent(initial.id, owner, binding, "requested");
  await assert.rejects(journal.claimInput(initial.id, owner, binding, "after-cancel", {}), /not accepting/u);
  await journal.cancelIntent(initial.id, owner, binding, "acknowledged");
  assert.equal((await journal.get(initial.id, owner, binding)).status, "input_required");
  await assert.rejects(journal.cancelIntent(initial.id, owner, binding, "requested"), /already requested/u);
  // Cooperative cancellation can lose a race to successful completion.
  await journal.observe(initial.id, owner, binding, { ...seed, resultType: "complete", status: "completed", result: { content: [{ type: "text", text: "private result" }] } }, "state");
  assert.doesNotMatch(JSON.stringify(await journal.list(owner)), /private result/u);
  await assert.rejects(journal.observe(initial.id, owner, binding, { ...seed, resultType: "complete" }, "state"), /terminal/u);
  await journal.forget(initial.id, owner, binding);
  assert.deepEqual(await journal.list(owner), []);
  // Forgetting is local; a stale remote id cannot be rebound into another Session.
  await assert.rejects(journal.observe(other.id, otherOwner, binding, seed, "created"), /another Session/u);

  assert.equal(parseMcpTask(seed, "created", "remote").taskId, seed.taskId);
  for (const invalid of [{ ...seed, resultType: "complete" }, { ...seed, task: seed }, { ...seed, ttlMs: -1 }, { ...seed, createdAt: "2026-02-31T00:00:00Z" }, { ...seed, taskId: "bad\nid" }]) {
    // Unknown fields are not used as an era bridge; legacy nested tasks lack a flat id.
    if (invalid.task) delete invalid.taskId;
    assert.throws(() => parseMcpTask(invalid, "created", "remote"), /invalid/u);
  }
  assert.throws(() => parseMcpTask({ ...pending, inputRequests: {} }, "state", "remote"), /invalid/u);
  assert.throws(() => parseMcpTask({ ...seed, resultType: "complete", status: "failed", error: {} }, "state", "remote"), /invalid/u);
});

test("task journal uses encrypted atomic storage, fails closed on partial writes/corruption and bounds retained handles", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "may-task-journal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let password;
  const keyring = { getPassword: async () => password, setPassword: async (value) => { password = value; } };
  const store = new KeyringMcpCredentialStore(directory, keyring);
  const journal = new McpTaskJournal(store);
  const record = await journal.begin(owner, binding);
  await journal.observe(record.id, owner, binding, seed, "created");
  const reopened = new McpTaskJournal(new KeyringMcpCredentialStore(directory, keyring));
  assert.equal((await reopened.get(record.id, owner, binding)).remote.taskId, seed.taskId);
  const files = await readdir(directory);
  for (const name of files) {
    const raw = await readFile(join(directory, name), "utf8");
    assert.doesNotMatch(raw, /remote-task|workspace-A|session-A|slow/u);
  }
  const originalSet = store.set.bind(store);
  let fail = false;
  store.set = async (key, value) => { if (fail && key.startsWith("mcp-tasks.v1:")) throw new Error("simulated write failure"); return originalSet(key, value); };
  const abandoned = await journal.begin(owner, binding);
  fail = true;
  await assert.rejects(journal.observe(abandoned.id, owner, binding, { ...seed, taskId: "reserved-before-crash" }, "created"), /write failure/u);
  fail = false;
  assert.equal((await reopened.get(abandoned.id, owner, binding)).status, "starting");
  const wrongOwner = { ...owner, sessionId: "new" };
  const wrong = await journal.begin(wrongOwner, binding);
  await assert.rejects(journal.observe(wrong.id, wrongOwner, binding, { ...seed, taskId: "reserved-before-crash" }, "created"), /another Session/u);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(journal.begin(owner, binding, cancelled.signal));
  assert.equal((await journal.list(owner)).length, 2);

  const memory = new McpTaskJournal(new InMemoryMcpCredentialStore());
  await Promise.all(Array.from({ length: 64 }, () => memory.begin(owner, binding)));
  await assert.rejects(memory.begin(owner, binding), /journal is full/u);
  assert.equal((await memory.list(owner)).length, 64);
  // Corrupt the encrypted Session file, not the keyring entry or another workspace.
  const path = join(directory, files.find((name) => name.endsWith(".json")));
  const bytes = JSON.parse(await readFile(path, "utf8")); bytes.tag = Buffer.alloc(16).toString("base64");
  await writeFile(path, JSON.stringify(bytes));
  const broken = new McpTaskJournal(new KeyringMcpCredentialStore(directory, keyring));
  // The first file can be the Session or ownership index: either path fails closed.
  await assert.rejects(async () => { await broken.get(record.id, owner, binding); await broken.observe(record.id, owner, binding, { ...seed, resultType: "complete" }, "state"); }, /vault|journal|credentials/u);
});
