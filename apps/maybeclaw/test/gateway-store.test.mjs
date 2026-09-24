import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { FileSessionStore } from "@may/session/file-store";
import { ChannelStore, cursorId, inboxId } from "../dist/channel-store.js";
import { checkLegacy, migrateLegacy } from "../dist/gateway-migration.js";
import { GatewayStore } from "../dist/gateway-store.js";
import { FileTaskStore } from "../dist/store.js";
import { digest, taskId } from "../dist/types.js";

const testDirectory = fileURLToPath(new URL("../../../.zcode/tmp/maybeclaw-storage-tests/", import.meta.url));
const ownedStores = new Map();

async function directory(t) {
  await mkdir(testDirectory, { recursive: true });
  const path = await mkdtemp(join(testDirectory, "case-"));
  ownedStores.set(path, new Set());
  t.after(async () => {
    for (const store of ownedStores.get(path)) store.close();
    ownedStores.delete(path);
    assert.ok(resolve(path).startsWith(resolve(testDirectory) + sep));
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function openStore(path) {
  const store = GatewayStore.open(path);
  ownedStores.get(path).add(store);
  return store;
}

async function writeTask(directory, requestId, status = "queued") {
  const store = new FileTaskStore(directory);
  const configPath = join(directory, "config.json");
  await writeFile(configPath, JSON.stringify({ version: 1 }));
  const id = taskId(requestId);
  const initial = { version: 1, id, revision: 1, createdAt: 1, updatedAt: 1,
    spec: { requestId, prompt: "Inspect the migration record", configPath, modelProfile: "migration", modelFingerprint: digest("migration"),
      runBudget: { maxDurationMs: 60000, maxSteps: 4, maxModelCalls: 4, maxToolCalls: 4 } }, status: "queued", verification: "unverified" };
  const journal = await store.acquire(id);
  let current = initial;
  try {
    await journal.write(initial);
    if (status !== "queued") {
      current = { ...current, revision: 2, updatedAt: 2, status: "running" };
      await journal.write(current);
      if (status !== "running") {
        current = { ...current, revision: 3, updatedAt: 3, status, ...(status === "completed" ? { result: "Completed record" } : {}) };
        await journal.write(current);
      }
    }
  } finally { await journal.close(); }
  return current;
}

test("SQLite records persist across reopen and isolated reads cannot mutate stored values", async (t) => {
  const path = await directory(t);
  const store = openStore(path);
  store.put("sessions", "alpha", { title: "讨论", nested: { value: 1 } });
  store.get("sessions", "alpha").nested.value = 2;
  store.list("sessions")[0].title = "changed";
  assert.deepEqual(store.get("sessions", "alpha"), { title: "讨论", nested: { value: 1 } });
  store.close();
  const reopened = openStore(path);
  t.after(() => reopened.close());
  assert.equal(reopened.get("sessions", "alpha").title, "讨论");
  reopened.delete("sessions", "alpha");
  assert.equal(reopened.get("sessions", "alpha"), undefined);
});

test("SQLite transactions preserve atomic related records and nested savepoints", async (t) => {
  const store = openStore(await directory(t));
  t.after(() => store.close());
  assert.throws(() => store.transaction(() => {
    store.put("messages", "one", { text: "input" });
    store.put("runs", "one", { messageId: "one" });
    throw new Error("Rejected admission");
  }), /Rejected admission/);
  assert.deepEqual(store.list("messages"), []);
  assert.deepEqual(store.list("runs"), []);
  store.transaction(() => {
    store.put("messages", "two", { text: "accepted" });
    assert.throws(() => store.transaction(() => {
      store.put("messages", "three", { text: "rejected" });
      throw new Error("Rejected nested operation");
    }), /Rejected nested/);
    store.put("runs", "two", { messageId: "two" });
  });
  assert.deepEqual(store.list("messages"), [{ text: "accepted" }]);
  assert.deepEqual(store.list("runs"), [{ messageId: "two" }]);
  assert.throws(() => store.transaction(async () => store.put("messages", "async", {})), /synchronous/);
  assert.equal(store.get("messages", "async"), undefined);
  assert.throws(() => store.put("records; DROP TABLE records", "one", {}), /collection/);
  assert.throws(() => store.get("records", "\u0000"), /record ID/);
});

test("host lock rejects a real second process and a later owner can reopen", async (t) => {
  const path = await directory(t);
  const store = openStore(path);
  const moduleUrl = new URL("../dist/gateway-store.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { GatewayStore } from ${JSON.stringify(moduleUrl)}; GatewayStore.open(process.argv[1]);`, path], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /EEXIST/);
  store.close();
  const reopened = openStore(path);
  reopened.close();
});

test("process termination cannot commit half a SQLite transaction", async (t) => {
  const path = await directory(t);
  const moduleUrl = new URL("../dist/gateway-store.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { GatewayStore } from ${JSON.stringify(moduleUrl)}; const store = GatewayStore.open(process.argv[1]); store.transaction(() => { store.put("messages", "unfinished", {}); process.exit(9); });`, path], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 9);
  await unlink(join(path, "host.lock"));
  const store = openStore(path);
  t.after(() => store.close());
  assert.equal(store.get("messages", "unfinished"), undefined);
});

test("unsupported SQLite schema version fails without retaining its host lock", async (t) => {
  const path = await directory(t);
  openStore(path).close();
  const database = new DatabaseSync(join(path, "gateway.sqlite"));
  database.exec("PRAGMA user_version = 999");
  database.close();
  assert.throws(() => GatewayStore.open(path), /newer MaybeClaw/);
  await assert.rejects(readFile(join(path, "host.lock")), { code: "ENOENT" });
});

test("a new Gateway database prevents legacy task writes before a migration marker exists", async (t) => {
  const path = await directory(t);
  const gateway = openStore(path);
  const legacy = new FileTaskStore(path);
  await assert.rejects(legacy.acquire(taskId("new-task")), /Gateway format/);
  await assert.rejects(legacy.requestCancel(taskId("new-task")), /Gateway format/);
  await assert.rejects(ChannelStore.open(join(path, "channels.jsonl")), /read-only/);
  await assert.rejects(readFile(join(path, "gateway.format.json")), { code: "ENOENT" });
  gateway.close();
});

test("legacy migration preserves original IDs, history, delivery states, origins and backup bytes", async (t) => {
  const path = await directory(t);
  const completed = await writeTask(path, "completed", "completed");
  const queued = await writeTask(path, "queued");
  const interrupted = await writeTask(path, "interrupted", "running");
  const historyStore = new FileSessionStore(join(path, "sessions"));
  const history = [
    { type: "session.created", metadata: { maybeclaw: { version: 1, taskId: interrupted.id, specDigest: digest(interrupted.spec) } } },
    { type: "input.submitted", inputId: `${interrupted.id}:input`, message: { role: "user", content: [{ type: "text", text: interrupted.spec.prompt }] } },
    { type: "run.started", runId: "interrupted-run" },
  ].map((event, index) => ({ ...event, sessionId: interrupted.id, seq: index + 1, timestamp: index + 1 }));
  for (const event of history) await historyStore.append(event);
  const partialPath = join(path, "sessions", `${Buffer.from(interrupted.id).toString("base64url")}.jsonl`);
  await appendFile(partialPath, '{"incomplete":');
  const historyBytes = await readFile(partialPath);
  const channels = await ChannelStore.open(join(path, "channels.jsonl"));
  const input = { account: "telegram:42", eventId: "10", sender: "123", conversation: "123", text: completed.spec.prompt };
  await channels.put({ kind: "inbox", id: inboxId(input), input, processed: true, taskId: completed.id });
  const sentId = digest("sent-delivery");
  const pendingId = digest("pending-delivery");
  const unknownId = digest("sending-delivery");
  const destination = { kind: "delivery", account: input.account, sender: input.sender, conversation: input.conversation, text: "result", taskId: completed.id };
  await channels.put({ ...destination, id: sentId, status: "sent" });
  await channels.put({ ...destination, id: pendingId, after: sentId, status: "pending" });
  await channels.put({ ...destination, id: unknownId, after: pendingId, status: "sending" });
  await channels.put({ kind: "cursor", id: cursorId(input.account), offset: 11 });
  await channels.close();
  await appendFile(join(path, "channels.jsonl"), '{"incomplete":');
  const channelBytes = await readFile(join(path, "channels.jsonl"));
  const check = await checkLegacy(path);
  assert.equal(check.tasks, 3);
  assert.equal(check.awaitingAssignment, 1);
  assert.equal(check.recoveryRequired, 1);
  assert.equal(check.unknownDeliveries, 1);
  assert.equal(check.canMigrate, true);
  assert.deepEqual(await readFile(partialPath), historyBytes);
  assert.deepEqual(await readFile(join(path, "channels.jsonl")), channelBytes);
  const result = await migrateLegacy(path);
  assert.equal(result.alreadyMigrated, false);
  assert.deepEqual(await readFile(partialPath), historyBytes);
  assert.deepEqual(await readFile(join(result.backupDirectory, "sessions", `${Buffer.from(interrupted.id).toString("base64url")}.jsonl`)), historyBytes);
  assert.deepEqual(await readFile(join(result.backupDirectory, "channels.jsonl")), channelBytes);
  const store = openStore(path);
  assert.equal(store.get("legacy-tasks", queued.id).status, "awaiting-assignment");
  assert.equal(store.get("legacy-tasks", interrupted.id).status, "recovery-required");
  assert.deepEqual(store.get("legacy-tasks", interrupted.id).history, history);
  assert.deepEqual(store.get("legacy-tasks", completed.id).snapshot, completed);
  assert.deepEqual(store.get("legacy-tasks", completed.id).origins, [{ account: input.account, sender: input.sender, conversation: input.conversation, eventId: input.eventId }]);
  assert.deepEqual(store.get("legacy-tasks", queued.id).origins, []);
  assert.equal(store.get("legacy-deliveries", sentId).status, "sent");
  assert.equal(store.get("legacy-deliveries", pendingId).status, "pending");
  assert.equal(store.get("legacy-deliveries", unknownId).status, "unknown");
  assert.equal(store.get("legacy-deliveries", unknownId).after, pendingId);
  assert.equal(store.get("legacy-cursors", cursorId(input.account)).offset, 11);
  assert.deepEqual(store.list("sessions"), []);
  assert.deepEqual(store.list("runs"), []);
  store.close();
  assert.equal((await checkLegacy(path)).migrated, true);
  const repeated = await migrateLegacy(path);
  assert.equal(repeated.alreadyMigrated, true);
  assert.equal(repeated.backupDirectory, result.backupDirectory);
  await assert.rejects(new FileTaskStore(path).acquire(queued.id), /Gateway format/);
  await assert.rejects(new FileTaskStore(path).requestCancel(queued.id), /Gateway format/);
});

test("migration refuses an existing task owner and leaves source journals unchanged", async (t) => {
  const path = await directory(t);
  const task = await writeTask(path, "owned");
  const taskStore = new FileTaskStore(path);
  const bytes = await readFile(taskStore.path(task.id, "jsonl"));
  const owner = await taskStore.acquire(task.id);
  try {
    assert.equal((await checkLegacy(path)).canMigrate, false);
    await assert.rejects(migrateLegacy(path), /owner lock/);
    assert.deepEqual(await readFile(taskStore.path(task.id, "jsonl")), bytes);
    await assert.rejects(readFile(join(path, "gateway.sqlite")), { code: "ENOENT" });
  } finally { await owner.close(); }
});

test("legacy cancellation intent prevents queued work becoming eligible for assignment", async (t) => {
  const path = await directory(t);
  const task = await writeTask(path, "cancel-requested");
  await new FileTaskStore(path).requestCancel(task.id);
  await migrateLegacy(path);
  const store = openStore(path);
  t.after(() => store.close());
  const migrated = store.get("legacy-tasks", task.id);
  assert.equal(migrated.status, "cancelled");
  assert.equal(migrated.cancellationRequested, true);
  assert.equal(migrated.snapshot.status, "queued");
});

test("invalid legacy references reject migration before a new database is created", async (t) => {
  const path = await directory(t);
  const channels = await ChannelStore.open(join(path, "channels.jsonl"));
  await channels.put({ kind: "delivery", id: digest("orphan"), account: "telegram:42", sender: "123", conversation: "123", text: "orphan", taskId: taskId("missing"), status: "pending" });
  await channels.close();
  await assert.rejects(checkLegacy(path), /missing task/);
  await assert.rejects(migrateLegacy(path), /missing task/);
  await assert.rejects(readFile(join(path, "gateway.sqlite")), { code: "ENOENT" });
});
