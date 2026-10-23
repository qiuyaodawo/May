import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fork } from "node:child_process";
import test from "node:test";
import { createMayConfig, loadMayConfig } from "../dist/index.js";

async function directory(t) {
  const base = fileURLToPath(new URL("../../../review/onboarding/", import.meta.url));
  await mkdir(base, { recursive: true });
  const path = await mkdtemp(join(base, "config-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("creates a readable config in a new directory and preserves existing files", async t => {
  const root = await directory(t);
  const path = join(root, "new", "config.json");
  await createMayConfig(path, { providers: {}, models: {} });
  assert.deepEqual((await loadMayConfig({ path })).providers, {});
  const original = await readFile(path, "utf8");
  await assert.rejects(createMayConfig(path, { providers: {} }), /already exists/);
  assert.equal(await readFile(path, "utf8"), original);
  assert.ok((await readdir(join(root, "new"))).every(name => !name.endsWith(".tmp")));
});

test("invalid input, cancellation and invalid parent paths leave no config", async t => {
  const root = await directory(t);
  const path = join(root, "config.json");
  await assert.rejects(createMayConfig(path, {}));
  await assert.rejects(createMayConfig(path, { providers: {} }, { signal: AbortSignal.abort() }));
  assert.deepEqual(await readdir(root), []);
  await writeFile(join(root, "parent"), "occupied");
  await assert.rejects(createMayConfig(join(root, "parent", "config.json"), { providers: {} }));
  assert.equal(await readFile(join(root, "parent"), "utf8"), "occupied");
});

test("two processes creating the same config publish exactly one complete file", async t => {
  const root = await directory(t);
  const path = join(root, "config.json");
  const children = ["first", "second"].map(name => fork(new URL("fixtures/create-worker.mjs", import.meta.url), [path, name], { silent: true, windowsHide: true }));
  const exits = children.map(child => new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => resolve(code));
  }));
  t.after(() => children.forEach(child => { if (child.exitCode === null) child.kill(); }));
  await Promise.all(children.map(child => new Promise(resolve => child.once("message", resolve))));
  children.forEach(child => child.send("create"));
  assert.deepEqual((await Promise.all(exits)).sort(), [0, 1]);
  const config = await loadMayConfig({ path });
  assert.ok(["first", "second"].includes(config.apps.marker.name));
  assert.ok((await readdir(root)).every(name => !name.endsWith(".tmp")));
});
