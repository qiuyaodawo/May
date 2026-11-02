import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { GatewayStore } from "../dist/gateway-store.js";

const children = new Map();

async function directory(t) {
  const root = fileURLToPath(new URL("../../../.test-output/gateway-lock/", import.meta.url));
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "case-"));
  children.set(path, []);
  t.after(async () => {
    await Promise.all(children.get(path).map(stop => stop()));
    children.delete(path);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function child(t, path, mode = "current") {
  const process = fork(new URL("fixtures/gateway-lock-child.mjs", import.meta.url), [path, mode], { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let ended = false;
  process.on("exit", () => { ended = true; });
  const stop = async () => {
    if (ended) return;
    const exit = once(process, "exit");
    process.kill("SIGKILL");
    await exit;
  };
  children.get(path).push(stop);
  assert.deepEqual((await once(process, "message"))[0], { ready: true });
  return { process, stop, open() { const result = once(process, "message"); process.send("open"); return result.then(([value]) => value); } };
}

test("forced termination releases ownership and preserves saved data", { timeout: 15000 }, async t => {
  const path = await directory(t), owner = await child(t, path);
  assert.equal((await owner.open()).opened, true);
  assert.throws(() => GatewayStore.open(path), /already in use/);
  await owner.stop();
  const store = GatewayStore.open(path);
  try {
    assert.deepEqual(store.get("sessions", "saved"), { text: "persisted" });
    assert.throws(() => GatewayStore.open(path), /already in use/);
  } finally { store.close(); }
  assert.equal(await readFile(join(path, "host.lock.access"), "utf8"), "");
  GatewayStore.open(path).close();
});

for (const abandoned of [false, true]) {
  test(`concurrent processes admit one owner; abandoned=${abandoned}`, { timeout: 15000 }, async t => {
    const path = await directory(t);
    if (abandoned) {
      const previous = await child(t, path);
      assert.equal((await previous.open()).opened, true);
      await previous.stop();
    }
    const first = await child(t, path), second = await child(t, path);
    const results = await Promise.all([first.open(), second.open()]);
    assert.equal(results.filter(result => result.opened).length, 1);
    assert.match(results.find(result => !result.opened).error, /already in use/);
  });
}

test("live legacy owner is preserved; recovery succeeds after termination", { timeout: 15000 }, async t => {
  const path = await directory(t), owner = await child(t, path, "legacy");
  assert.equal((await owner.open()).opened, true);
  const contents = await readFile(join(path, "host.lock"), "utf8");
  assert.throws(() => GatewayStore.open(path), /still running/);
  assert.equal(await readFile(join(path, "host.lock"), "utf8"), contents);
  await owner.stop();
  GatewayStore.open(path).close();
});

test("unverifiable and damaged metadata remain available for inspection", async t => {
  const path = await directory(t), lock = join(path, "host.lock");
  for (const contents of ["", "{", "null", JSON.stringify({ pid: process.pid, hostname: "other-host" }), JSON.stringify({ pid: -1, hostname: hostname() })]) {
    await writeFile(lock, contents);
    assert.throws(() => GatewayStore.open(path), /metadata|verify/);
    assert.equal(await readFile(lock, "utf8"), contents);
  }
  await unlink(lock);
  GatewayStore.open(path).close();
});

test("directory aliases cannot acquire a second owner", async t => {
  const path = await directory(t), alias = `${path}-alias`;
  await symlink(path, alias, process.platform === "win32" ? "junction" : "dir");
  t.after(() => rm(alias));
  const store = GatewayStore.open(path);
  try { assert.throws(() => GatewayStore.open(alias), /already in use/); }
  finally { store.close(); }
});

test("database open failure releases ownership for the next attempt", async t => {
  const path = await directory(t), database = join(path, "gateway.sqlite");
  await mkdir(database);
  assert.throws(() => GatewayStore.open(path));
  await rm(database, { recursive: true });
  GatewayStore.open(path).close();
});

test("changed lock contents are preserved on close and native ownership is released", async t => {
  const path = await directory(t), store = GatewayStore.open(path), lock = join(path, "host.lock");
  const replacement = JSON.stringify({ pid: process.pid, hostname: hostname(), token: "changed" });
  await writeFile(lock, replacement);
  assert.throws(() => store.close(), /ownership changed/);
  assert.equal(await readFile(lock, "utf8"), replacement);
  await unlink(lock);
  GatewayStore.open(path).close();
});
