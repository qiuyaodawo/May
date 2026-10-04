import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AgentApplication, AgentWorkspace } from "../dist/index.js";
import { DeepSeekModel } from "../../providers/deepseek/dist/index.js";
import { InMemorySessionCatalog } from "../../session/dist/catalog.js";
import { FileSessionStore } from "../../session/dist/file-store.js";
import { FilePermissionRuleStore } from "../../permissions/dist/file-store.js";

const execute = promisify(execFile);
const verificationDirectory = fileURLToPath(new URL("../../../plugin-verification/persistent-integration/", import.meta.url));
const scopeId = "project:may:agent:writer";
const tool = { name: "write", description: "Write project Markdown", inputSchema: { type: "object" }, permissionVersion: "1" };
const policy = () => ({ decision: "ask", grantKey: "docs-markdown", persistent: { scopeId, description: "Modify Markdown files under project docs" } });

function applicationOptions(store, permissionRuleStore) {
  return {
    store,
    permissionRuleStore,
    permissionPolicy: policy,
    model: new DeepSeekModel({ apiKey: "unused-for-offline-rule-management", model: "deepseek-chat" }),
  };
}

function permissionCheck() {
  return { tool, input: { path: "docs/guide.md" }, context: { runId: "rule-management", step: 1, toolCallId: "write-guide", idempotencyKey: "write-guide", signal: new AbortController().signal, report() {} } };
}

async function directory(t) {
  await mkdir(verificationDirectory, { recursive: true });
  const directory = await mkdtemp(join(verificationDirectory, "run-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("application rule management persists history and reopens a shared rule store", async t => {
  const root = await directory(t), store = new FileSessionStore(join(root, "sessions"));
  const permissionRuleStore = await FilePermissionRuleStore.open({ path: join(root, "permission-rules.json") });
  const app = await AgentApplication.open(applicationOptions(store, permissionRuleStore));
  const sessionId = app.sessionId;
  const rule = await app.createPermissionRule(permissionCheck(), { decision: "allow", createdBy: "local-operator" });
  assert.equal(rule.scopeId, scopeId);
  assert.equal(rule.description, policy().persistent.description);
  assert.deepEqual(await app.listPermissionRules(scopeId), [rule]);
  assert.deepEqual(await app.listPermissionRules("another-project"), []);
  assert.equal((await app.queryHistory({ types: ["rule.created"] })).events[0].rule.id, rule.id);
  await app.close();
  await permissionRuleStore.close();

  const child = await execute(process.execPath, [fileURLToPath(new URL("./persistent-permissions-reader.mjs", import.meta.url)), store.directory, sessionId]);
  assert.deepEqual(JSON.parse(child.stdout), { types: ["session.created", "rule.created"], ruleIds: [rule.id] });

  const reopenedRules = await FilePermissionRuleStore.open({ path: join(root, "permission-rules.json") });
  const reopened = await AgentApplication.open({ ...applicationOptions(store, reopenedRules), sessionId, resume: true });
  assert.deepEqual(await reopened.listPermissionRules(), [rule]);
  assert.equal(await reopened.revokePermissionRule(rule.id), true);
  assert.equal(await reopened.revokePermissionRule(rule.id), false);
  assert.deepEqual(await reopened.listPermissionRules(), []);
  const history = await reopened.queryHistory({ types: ["rule.created", "rule.revoked"] });
  assert.deepEqual(history.events.map(event => event.type), ["rule.created", "rule.revoked"]);
  assert.equal((await reopened.inspectContext()).messageCount, 0);
  await reopened.close();
  await reopenedRules.close();
});

test("workspace delegates trusted rule management to the current application", async t => {
  const root = await directory(t), store = new FileSessionStore(join(root, "sessions"));
  const rules = await FilePermissionRuleStore.open({ path: join(root, "permission-rules.json") });
  const workspace = await AgentWorkspace.open({ workspace: root, store, catalog: new InMemorySessionCatalog(),
    openApplication: selection => AgentApplication.open({ ...applicationOptions(store, rules), ...selection }),
  });
  const rule = await workspace.createPermissionRule(permissionCheck(), { decision: "deny", createdBy: "local-operator" });
  assert.deepEqual(await workspace.listPermissionRules(scopeId), [rule]);
  const allowed = await workspace.createPermissionRuleFrom(rule.id, { decision: "allow", createdBy: "second-operator" });
  assert.equal(allowed.scopeId, rule.scopeId);
  assert.equal(allowed.definitionKey, rule.definitionKey);
  assert.equal(allowed.grantKey, rule.grantKey);
  assert.equal(allowed.createdBy, "second-operator");
  assert.equal(allowed.decision, "allow");
  await assert.rejects(workspace.createPermissionRuleFrom("unavailable", { decision: "allow", createdBy: "local-operator" }));
  await workspace.newSession();
  assert.deepEqual(await workspace.listPermissionRules(scopeId), [rule, allowed]);
  const denied = await workspace.createPermissionRuleFrom(allowed.id, { decision: "deny", createdBy: "local-operator" });
  assert.equal(denied.scopeId, allowed.scopeId);
  assert.equal(denied.definitionKey, allowed.definitionKey);
  assert.equal(denied.grantKey, allowed.grantKey);
  assert.equal(denied.decision, "deny");
  assert.equal(await workspace.revokePermissionRule(rule.id), true);
  assert.equal(await workspace.revokePermissionRule(allowed.id), true);
  assert.equal(await workspace.revokePermissionRule(denied.id), true);
  assert.deepEqual(await workspace.listPermissionRules(), []);
  await workspace.close();
  await rules.close();
});

test("file history validates persistent metadata, approval decisions and rule evidence", async t => {
  const root = await directory(t), store = new FileSessionStore(root);
  const sessionId = "persistent-history";
  const base = { sessionId, timestamp: 100 };
  const events = [
    { type: "session.created" },
    { type: "approval.requested", request: { id: "approval", createdAt: 100, tool, input: { path: "docs/guide.md" }, runId: "run", step: 1, toolCallId: "call", idempotencyKey: "call", grantKey: "docs-markdown", persistent: { scopeId, description: "Project docs Markdown", definitionKey: "v1" } } },
    { type: "approval.resolved", requestId: "approval", decision: "allow-persistent" },
    { type: "rule.used", ruleId: "rule", scopeId, decision: "allow", runId: "run", toolCallId: "call" },
  ].map((event, index) => ({ ...event, ...base, seq: index + 1 }));
  for (const event of events) await store.append(event);
  assert.deepEqual(await new FileSessionStore(root).read(sessionId), events);

  for (const [index, invalid] of [
    { type: "rule.used", ruleId: "rule", scopeId, decision: "ask", runId: "run", toolCallId: "call" },
    { type: "rule.created", rule: { id: "incomplete" } },
    { type: "approval.requested", request: { ...events[1].request, persistent: { scopeId, description: "scope" } } },
  ].entries()) {
    const id = `invalid-${index}`;
    const path = join(root, `${Buffer.from(id).toString("base64url")}.jsonl`);
    await writeFile(path, `${JSON.stringify({ ...invalid, sessionId: id, seq: 1, timestamp: 100 })}\n`);
    await assert.rejects(new FileSessionStore(root).read(id), /Invalid session event/);
  }
});
