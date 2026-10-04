import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createReadTool, createShellTool, createWriteTool } from "@may/coding-tools";
import { PermissionDeniedError, PermissionToolExecutor } from "@may/permissions";
import { FilePermissionRuleStore } from "@may/permissions/file-store";
import { createCodingPermissionPolicy, executeMaybeCodeSlashCommand, openConfiguredMaybeCode } from "../dist/index.js";
import { createMaybeCodeWebHost } from "../dist/web-ui.js";

const artifacts = fileURLToPath(new URL("../../../review/persistent-rules/maybecode/", import.meta.url));
const resources = new Map();

async function directory(t) {
  await mkdir(artifacts, { recursive: true });
  const value = await mkdtemp(join(artifacts, "project-"));
  const cleanup = [];
  resources.set(value, cleanup);
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    assert.ok(resolve(value).startsWith(`${resolve(artifacts)}${sep}`));
    await rm(value, { recursive: true, force: true });
    resources.delete(value);
  });
  return value;
}

function context(signal = new AbortController().signal) {
  return { runId: "permission-verification", step: 1, toolCallId: "write", idempotencyKey: "permission-verification:1:write", signal,
    report(update) { assert.ok(["output.delta", "progress"].includes(update.type)); } };
}

async function approval(executor, operation) {
  const events = executor.events[Symbol.asyncIterator]();
  const result = executor.execute(operation);
  let event;
  do { event = await events.next(); } while (!event.done && event.value.type !== "approval.requested");
  assert.equal(event.done, false);
  return { request: event.value.request, result };
}

test("file rules reuse canonical paths across reopening and retain exact file scope", async t => {
  const root = await directory(t);
  await mkdir(join(root, "docs"));
  const path = join(root, ".may", "permission-rules.json");
  const tool = createWriteTool({ cwd: root });
  const policy = createCodingPermissionPolicy({ persistent: { workspace: root, scopeId: "project:alice:main" } });
  const store = await FilePermissionRuleStore.open({ path });
  const first = new PermissionToolExecutor({ policy, ruleStore: store });
  resources.get(root).push(() => store.close(), () => first.close());
  const initial = await approval(first, { tool, input: tool.parse({ path: "docs/guide.md", content: "secret-original-content" }), context: context() });
  assert.equal(initial.request.grantKey, "write:docs/guide.md");
  await first.resolve(initial.request.id, "allow-persistent", { createdBy: "local:alice" });
  await initial.result;
  assert.equal((await store.list())[0].scopeId, "project:alice:main");
  assert.equal((await readFile(path, "utf8")).includes("secret-original-content"), false);
  await first.close();
  await store.close();
  const reopened = await FilePermissionRuleStore.open({ path });
  const next = new PermissionToolExecutor({ policy, ruleStore: reopened });
  resources.get(root).push(() => reopened.close(), () => next.close());
  await next.execute({ tool, input: tool.parse({ path: "./docs/../docs/guide.md", content: "updated" }), context: context() });
  assert.equal(await readFile(join(root, "docs", "guide.md"), "utf8"), "updated");
  const abort = new AbortController();
  const other = await approval(next, { tool, input: tool.parse({ path: "docs/other.md", content: "unapproved" }), context: context(abort.signal) });
  assert.equal(other.request.grantKey, "write:docs/other.md");
  const rejected = assert.rejects(other.result);
  abort.abort("verification finished");
  await rejected;
  await assert.rejects(stat(join(root, "docs", "other.md")), { code: "ENOENT" });
});

test("canonical directory aliases retain rules and rule files remain protected", async t => {
  const root = await directory(t), outside = await directory(t);
  await mkdir(join(root, "docs"));
  await mkdir(join(root, "settings"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(join(root, "docs"), join(root, "alias"), linkType);
  await symlink(join(root, "settings"), join(root, ".may"), linkType);
  await symlink(outside, join(root, "outside"), linkType);
  const policy = createCodingPermissionPolicy({ persistent: { workspace: root, scopeId: "project:alice:main" } });
  const write = createWriteTool({ cwd: root });
  const check = input => ({ tool: write, input, context: context() });
  await writeFile(join(root, "docs", "guide.md"), "original");
  assert.equal((await policy(check({ path: "alias/guide.md", content: "allowed" }))).grantKey, "write:docs/guide.md");
  assert.equal((await policy(check({ path: "alias/nested/new.md", content: "allowed" }))).grantKey, "write:docs/nested/new.md");
  await assert.rejects(policy(check({ path: "outside/file.md", content: "outside" })), /workspace/i);
  const rules = await FilePermissionRuleStore.open({ path: join(root, ".may", "permission-rules.json") });
  resources.get(root).push(() => rules.close());
  for (const path of [".may/permission-rules.json", "settings/permission-rules.json", "settings/permission-rules.json.lock", "settings/permission-rules.json.unused.tmp"]) {
    assert.equal(await policy(check({ path, content: "unapproved" })), "deny");
  }
  assert.equal(await policy({ tool: createReadTool({ cwd: root }), input: { path: "settings/permission-rules.json" }, context: context() }), "deny");
});

test("persistent deny and requireApproval remain enforced in YOLO", async t => {
  const root = await directory(t);
  const store = await FilePermissionRuleStore.open({ path: join(root, ".may", "permission-rules.json") });
  const tool = createWriteTool({ cwd: root });
  const input = tool.parse({ path: "denied.md", content: "denied" });
  const executor = new PermissionToolExecutor({ ruleStore: store,
    policy: createCodingPermissionPolicy({ mode: () => "yolo", persistent: { workspace: root, scopeId: "project:alice:main" } }) });
  resources.get(root).push(() => store.close(), () => executor.close());
  const denied = await executor.createRule({ tool, input, context: context() }, { decision: "deny", createdBy: "local:alice" });
  await assert.rejects(executor.execute({ tool, input, context: context() }), PermissionDeniedError);
  await assert.rejects(stat(join(root, input.path)), { code: "ENOENT" });
  await executor.revokeRule(denied.id);
  await executor.execute({ tool, input, context: context() });
  assert.equal(await readFile(join(root, input.path), "utf8"), "denied");
  const fresh = new PermissionToolExecutor({ ruleStore: store,
    policy: createCodingPermissionPolicy({ mode: () => "yolo", policy: () => ({ decision: "ask", grantKey: "fresh", requireApproval: true }),
      persistent: { workspace: root, scopeId: "project:alice:main" } }) });
  resources.get(root).push(() => fresh.close());
  const pending = await approval(fresh, { tool, input, context: context() });
  assert.equal(pending.request.persistent, undefined);
  assert.equal(pending.request.grantKey, undefined);
  await fresh.resolve(pending.request.id, "allow");
  await pending.result;
  const shell = createShellTool({ cwd: root });
  const shellPolicy = createCodingPermissionPolicy({ persistent: { workspace: root, scopeId: "project:alice:main" } });
  assert.equal((await shellPolicy({ tool: shell, input: shell.parse({ command: "echo confidential" }), context: context() })).persistent, undefined);
});

test("custom policies retain their explicit grant scope and persistence choice", async t => {
  const root = await directory(t), tool = createWriteTool({ cwd: root });
  const persistent = { workspace: root, scopeId: "project:alice:main" };
  const policy = createCodingPermissionPolicy({ persistent,
    policy: check => ({ decision: "ask", grantKey: `content:${check.input.content}` }) });
  const first = await policy({ tool, input: { path: "guide.md", content: "approved" }, context: context() });
  const second = await policy({ tool, input: { path: "guide.md", content: "different" }, context: context() });
  assert.equal(first.grantKey, "content:approved");
  assert.equal(second.grantKey, "content:different");
  assert.equal(first.persistent, undefined);
  const configured = { decision: "ask", grantKey: "trusted:docs", persistent: { scopeId: persistent.scopeId, description: "修改 docs 文件" } };
  const explicit = createCodingPermissionPolicy({ persistent, policy: () => configured });
  assert.deepEqual(await explicit({ tool, input: { path: "guide.md", content: "approved" }, context: context() }), configured);
});

async function configured(t, persistentRules) {
  const root = await directory(t), configPath = join(root, "config.json");
  await writeFile(configPath, JSON.stringify({ providers: { deepseek: { adapter: "deepseek-chat", apiKey: "unused-local-test-key" } },
    models: { chat: { provider: "deepseek", model: "deepseek-chat", capabilities: { reasoning: false } } }, defaultModel: "chat",
    apps: { maybecode: persistentRules === undefined ? {} : { persistentRules } } }));
  const options = { configPath, workspace: root, dataDirectory: join(root, "sessions"), git: false,
    skills: false, goals: false, subagents: false, mcp: false, retry: false, observability: false };
  return { root, options };
}

test("configured host owns the shared store across sessions and supports rule management", async t => {
  const { root, options } = await configured(t, true);
  let app = await openConfiguredMaybeCode(options);
  resources.get(root).push(() => app.close());
  assert.equal(app.persistentRulesEnabled, true);
  const tool = createWriteTool({ cwd: root });
  const rule = await app.createPermissionRule({ tool, input: tool.parse({ path: "guide.md", content: "unused" }), context: context() },
    { decision: "allow", createdBy: "local:operator" });
  assert.deepEqual(await app.listPermissionRules(), [rule]);
  await app.newSession();
  assert.deepEqual(await app.listPermissionRules(), [rule]);
  const listing = await executeMaybeCodeSlashCommand("/permissions list", app);
  assert.match(listing.text, /guide\.md/);
  const denied = await executeMaybeCodeSlashCommand(`/permissions deny ${rule.id}`, app);
  assert.match(denied.text, /已创建禁止规则/);
  const current = await app.listPermissionRules();
  assert.equal(current.length, 2);
  assert.equal(current[1].decision, "deny");
  const host = createMaybeCodeWebHost(app);
  const snapshot = await host.snapshot();
  assert.ok(snapshot.commands.includes("permission.rules.list"));
  await host.close();
  await app.close();
  app = await openConfiguredMaybeCode(options);
  assert.deepEqual(await app.listPermissionRules(), current);
  await assert.rejects(app.listPermissionRules("different-actor"), /范围/);
  await executeMaybeCodeSlashCommand(`/permissions revoke ${rule.id}`, app);
  assert.equal((await app.listPermissionRules()).length, 1);
  await app.close();
  await assert.rejects(stat(join(root, ".may", "permission-rules.json.lock")), { code: "ENOENT" });
});

test("persistent rules are opt-in and malformed configuration fails", async t => {
  const { root, options } = await configured(t);
  const app = await openConfiguredMaybeCode(options);
  resources.get(root).push(() => app.close());
  assert.equal(app.persistentRulesEnabled, false);
  await assert.rejects(stat(join(root, ".may", "permission-rules.json")), { code: "ENOENT" });
  const host = createMaybeCodeWebHost(app);
  assert.equal((await host.snapshot()).commands.includes("permission.rules.list"), false);
  await host.close();
  await app.close();
  const invalid = await configured(t, "enabled");
  await assert.rejects(openConfiguredMaybeCode(invalid.options), /persistentRules/);
});
