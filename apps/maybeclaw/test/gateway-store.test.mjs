import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { GatewayStore } from "../dist/gateway-store.js";

const testDirectory = fileURLToPath(new URL("../../../.test-output/maybeclaw-storage/", import.meta.url));
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

function setSchemaVersion(path, version) {
  const database = new DatabaseSync(join(path, "gateway.sqlite"));
  try { database.exec(`PRAGMA user_version = ${version}`); } finally { database.close(); }
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
  assert.equal(reopened.get("sessions", "alpha").title, "讨论");
  reopened.delete("sessions", "alpha");
  assert.equal(reopened.get("sessions", "alpha"), undefined);
});

test("SQLite transactions preserve atomic related records and nested savepoints", async (t) => {
  const store = openStore(await directory(t));
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

test("process termination cannot commit half a SQLite transaction", async (t) => {
  const path = await directory(t);
  const moduleUrl = new URL("../dist/gateway-store.js", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { GatewayStore } from ${JSON.stringify(moduleUrl)}; const store = GatewayStore.open(process.argv[1]); store.transaction(() => { store.put("messages", "unfinished", {}); process.exit(9); });`, path], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 9);
  const store = openStore(path);
  assert.equal(store.get("messages", "unfinished"), undefined);
});

test("unsupported SQLite schema version fails and releases the host lock", async (t) => {
  const path = await directory(t);
  openStore(path).close();
  setSchemaVersion(path, 999);
  assert.throws(() => GatewayStore.open(path), /newer MaybeClaw/);
  setSchemaVersion(path, 1);
  openStore(path).close();
});
