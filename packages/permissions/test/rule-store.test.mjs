import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryPermissionRuleStore } from "../dist/index.js";
import { FilePermissionRuleStore } from "../dist/file-store.js";

const parent = fileURLToPath(new URL("../../../review/persistent-rules/", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/rule-store-process.mjs", import.meta.url));

async function directory(t) {
  await mkdir(parent, { recursive: true });
  const path = await mkdtemp(join(parent, "rule-store-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function rule(overrides = {}) {
  return {
    id: "rule_docs",
    scopeId: "project:may:user:owner:agent:writer",
    toolName: "write",
    definitionKey: "write:v1",
    grantKey: "docs-markdown",
    description: "Allow Markdown files in the project docs directory",
    decision: "allow",
    createdAt: 1_700_000_000_000,
    createdBy: "owner",
    ...overrides,
  };
}

function run(command, path, input) {
  return spawnSync(process.execPath, [fixture, command, path], {
    input: input === undefined ? "" : JSON.stringify(input),
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("memory rule store copies rules, isolates scopes, and revokes exact ids", async () => {
  const store = new InMemoryPermissionRuleStore();
  const original = rule();
  const saving = store.create(original);
  original.description = "Modified input";
  await saving;
  await store.create(rule({ id: "rule_other", scopeId: "project:other" }));
  const rules = await store.list(original.scopeId);
  assert.equal(rules.length, 1);
  assert.notEqual(rules[0], original);
  assert.equal(rules[0].description, rule().description);
  assert.ok(Object.isFrozen(rules));
  assert.ok(Object.isFrozen(rules[0]));
  assert.throws(() => { rules[0].decision = "deny"; }, TypeError);
  await assert.rejects(store.create(rule()), /already exists/);
  assert.equal(await store.revoke("missing"), false);
  assert.equal(await store.revoke(original.id), true);
  assert.deepEqual(await store.list(original.scopeId), []);
  assert.equal((await store.list()).length, 1);
});

test("rule validation rejects unsupported fields, accessors, invalid ids, decisions, and timestamps", async () => {
  const store = new InMemoryPermissionRuleStore();
  const invalid = [
    null, [], "rule",
    rule({ extra: true }), rule({ decision: "ask" }),
    rule({ createdAt: NaN }), rule({ createdAt: Infinity }),
    rule({ createdAt: Number.MAX_SAFE_INTEGER + 1 }), rule({ createdAt: -1 }),
    rule({ createdAt: 1.5 }), rule({ expiresAt: undefined }),
    rule({ expiresAt: NaN }), rule({ expiresAt: -1 }), rule({ expiresAt: 2.5 }),
  ];
  for (const field of ["id", "scopeId", "toolName", "definitionKey", "grantKey", "description", "createdBy"]) {
    invalid.push(rule({ [field]: " " }), rule({ [field]: 1 }));
    const missing = rule();
    delete missing[field];
    invalid.push(missing);
  }
  const missingDecision = rule();
  delete missingDecision.decision;
  invalid.push(missingDecision, rule({ [Symbol("unknown")]: true }));
  const accessor = rule();
  Object.defineProperty(accessor, "description", { get() { throw new Error("Accessor was invoked"); } });
  invalid.push(accessor);
  for (const value of invalid) await assert.rejects(store.create(value), TypeError);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.list(" "), TypeError);
  await assert.rejects(store.revoke(" "), TypeError);
  await store.create(rule({ expiresAt: 1_700_000_001_000 }));
});

test("file store serializes mutations and persists immutable snapshots after reopening", async (t) => {
  const root = await directory(t);
  const path = join(root, "nested", "permission-rules.json");
  const store = await FilePermissionRuleStore.open({ path });
  try {
    const original = rule();
    const first = store.create(original);
    original.description = "Changed after create";
    const second = store.create(rule({ id: "rule_other", scopeId: "project:other" }));
    const listed = store.list();
    await Promise.all([first, second]);
    assert.equal((await listed).length, 2);
    await assert.rejects(store.create(rule()), /already exists/);
    const rules = await store.list(rule().scopeId);
    assert.deepEqual(rules, [rule()]);
    assert.ok(Object.isFrozen(rules));
    assert.ok(Object.isFrozen(rules[0]));
    assert.equal(await store.revoke("missing"), false);
    assert.equal(await store.revoke("rule_other"), true);
    const disk = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(disk, { version: 1, rules: [rule()] });
    assert.deepEqual((await readdir(join(root, "nested"))).sort(), ["permission-rules.json", "permission-rules.json.lock"]);
  } finally { await store.close(); }
  await assert.rejects(store.list(), /closed/);
  await assert.rejects(store.create(rule({ id: "after_close" })), /closed/);
  const reopened = await FilePermissionRuleStore.open({ path });
  try { assert.deepEqual(await reopened.list(), [rule()]); }
  finally { await reopened.close(); }
  await assert.rejects(lstat(`${path}.lock`), { code: "ENOENT" });
});

test("separate processes create, reload, and revoke committed permission rules", async (t) => {
  const path = join(await directory(t), "permission-rules.json");
  for (const [command, input, expected] of [
    ["create", rule(), ""], ["list", undefined, JSON.stringify([rule()])],
    ["revoke", rule().id, "true"], ["list", undefined, "[]"],
  ]) {
    const child = run(command, path, input);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, expected);
  }
});

test("single writer lock rejects competing processes and is released only on close", async (t) => {
  const path = join(await directory(t), "permission-rules.json");
  const store = await FilePermissionRuleStore.open({ path });
  try {
    const child = run("list", path);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /EEXIST/);
    await assert.rejects(FilePermissionRuleStore.open({ path }), { code: "EEXIST" });
    assert.ok((await lstat(`${path}.lock`)).isFile());
    await store.create(rule());
  } finally { await store.close(); }
  const child = run("list", path);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [rule()]);
});

test("terminated writer leaves a lock and committed rules without automatic ownership recovery", async (t) => {
  const path = join(await directory(t), "permission-rules.json");
  const child = run("crash", path, rule());
  assert.equal(child.status, 23, child.stderr);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")).rules, [rule()]);
  await assert.rejects(FilePermissionRuleStore.open({ path }), { code: "EEXIST" });
  assert.ok((await lstat(`${path}.lock`)).isFile());
});

test("corrupt or unsupported files fail on open and release the newly acquired lock", async (t) => {
  const root = await directory(t);
  const invalid = [
    "{", JSON.stringify({ version: 2, rules: [] }),
    JSON.stringify({ version: 1, rules: [], extra: true }),
    JSON.stringify({ version: 1, rules: [rule(), rule()] }),
    JSON.stringify({ version: 1, rules: [rule({ decision: "ask" })] }),
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    const path = join(root, `invalid-${index}.json`);
    await writeFile(path, invalid[index]);
    await assert.rejects(FilePermissionRuleStore.open({ path }));
    await assert.rejects(lstat(`${path}.lock`), { code: "ENOENT" });
    assert.equal(await readFile(path, "utf8"), invalid[index]);
  }
});

test("read errors poison every subsequent operation even if the file is repaired externally", async (t) => {
  const path = join(await directory(t), "permission-rules.json");
  const store = await FilePermissionRuleStore.open({ path });
  try {
    await store.create(rule());
    await writeFile(path, "{");
    let failure;
    await assert.rejects(store.list(), (error) => { failure = error; return error instanceof SyntaxError; });
    await writeFile(path, JSON.stringify({ version: 1, rules: [rule()] }));
    await assert.rejects(store.list(), (error) => error === failure);
    await assert.rejects(store.create(rule({ id: "another" })), (error) => error === failure);
    await assert.rejects(store.revoke(rule().id), (error) => error === failure);
  } finally { await store.close(); }
});

test("deleted rule files fail subsequent checks and mutations", async (t) => {
  const path = join(await directory(t), "permission-rules.json");
  const store = await FilePermissionRuleStore.open({ path });
  try {
    await store.create(rule());
    await rm(path);
    await assert.rejects(store.list(), { code: "ENOENT" });
    await assert.rejects(store.revoke(rule().id), { code: "ENOENT" });
    await assert.rejects(store.create(rule({ id: "another" })), { code: "ENOENT" });
  } finally { await store.close(); }
});

test("actual filesystem write denial prevents revocation and poisons later checks", async (t) => {
  if (process.platform !== "win32" && process.geteuid?.() === 0) {
    t.skip("A privileged process can write despite filesystem permission restrictions");
    return;
  }
  const root = await directory(t);
  const path = join(root, "permission-rules.json");
  const store = await FilePermissionRuleStore.open({ path });
  await store.create(rule());
  const protectedPath = process.platform === "win32" ? path : root;
  await chmod(protectedPath, process.platform === "win32" ? 0o444 : 0o500);
  try {
    let failure;
    await assert.rejects(store.revoke(rule().id), (error) => {
      failure = error;
      return error.code === "EPERM" || error.code === "EACCES";
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).rules, [rule()]);
    await assert.rejects(store.list(), (error) => error === failure);
  } finally {
    await chmod(protectedPath, 0o700);
    await store.close();
  }
});

test("changed ownership prevents rule access and close preserves the replacement lock", async (t) => {
  const root = await directory(t);
  const path = join(root, "permission-rules.json");
  const store = await FilePermissionRuleStore.open({ path });
  await rename(`${path}.lock`, join(root, "original.lock"));
  await writeFile(`${path}.lock`, "replacement owner");
  await assert.rejects(store.list(), /ownership changed/);
  await assert.rejects(store.create(rule()), /ownership changed/);
  await assert.rejects(store.close(), /ownership changed/);
  assert.equal(await readFile(`${path}.lock`, "utf8"), "replacement owner");
});
