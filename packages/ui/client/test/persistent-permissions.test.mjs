import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { AgentApplication, AgentWorkspace } from "../../../application/dist/index.js";
import { InMemoryPermissionRuleStore, PermissionToolExecutor } from "../../../permissions/dist/index.js";
import { InMemorySessionStore } from "../../../session/dist/index.js";
import { InMemorySessionCatalog } from "../../../session/dist/catalog.js";
import { DeepSeekModel } from "../../../providers/deepseek/dist/index.js";
import { ApplicationUiHost } from "../dist/application.js";
import { UiProjection } from "../dist/projection.js";

const scopeId = "project:may:agent:writer";
const description = "Modify Markdown files under project docs";
const policy = () => ({ decision: "ask", grantKey: "docs-markdown", persistent: { scopeId, description } });
const toolDefinition = { name: "write", description: "Write project Markdown", inputSchema: { type: "object" }, permissionVersion: "1" };
const product = { id: "rules", title: "Rules", subtitle: "Permission management", resourceKind: "session", suggestions: [] };
const context = { runId: "real-file-operation", step: 1, toolCallId: "write-guide", idempotencyKey: "write-guide", signal: new AbortController().signal, report() {} };

test("projection offers persistent approval for a real file operation and retains read-only scope evidence", async t => {
  const verificationDirectory = fileURLToPath(new URL("../../../../plugin-verification/persistent-ui/", import.meta.url));
  await mkdir(verificationDirectory, { recursive: true });
  const root = await mkdtemp(join(verificationDirectory, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "guide.md");
  const executor = new PermissionToolExecutor({ policy, ruleStore: new InMemoryPermissionRuleStore() });
  t.after(() => executor.close());
  const iterator = executor.events[Symbol.asyncIterator]();
  const operation = executor.execute({ tool: { ...toolDefinition, async execute(input) { await writeFile(path, input.text); return path; } }, input: { text: "# Permission rules\n" }, context });
  const request = (await iterator.next()).value;
  assert.equal(request.type, "approval.requested");
  const projection = new UiProjection();
  projection.event({ type: "permission.event", event: request });
  assert.match(projection.interactions.get(request.request.id).detail, /Modify Markdown files under project docs/u);
  assert.equal(projection.interactions.get(request.request.id).choices.some(choice => choice.value === "allow-persistent"), true);
  await executor.resolve(request.request.id, "allow-persistent", { createdBy: "local-operator" });
  let resolved;
  while (!resolved) {
    const event = (await iterator.next()).value;
    projection.event({ type: "permission.event", event });
    if (event.type === "approval.resolved") resolved = event;
  }
  assert.equal(await operation, path);
  assert.equal(await readFile(path, "utf8"), "# Permission rules\n");
  assert.equal(projection.interactions.size, 0);
  assert.equal(projection.blocks.get(`tool:${context.runId}:${context.toolCallId}`).approval.scope, "persistent");
  assert.equal(projection.blocks.get(`tool:${context.runId}:${context.toolCallId}`).approval.scopeDescription, description);

  const history = new UiProjection();
  history.history([
    { type: "approval.requested", request: { id: request.request.id, createdAt: request.request.createdAt, tool: request.request.tool, input: request.request.input, runId: context.runId, step: context.step, toolCallId: context.toolCallId, idempotencyKey: context.idempotencyKey, grantKey: request.request.grantKey, persistent: request.request.persistent }, sessionId: "session", seq: 1, timestamp: request.timestamp },
    { type: "approval.resolved", requestId: request.request.id, decision: resolved.decision, sessionId: "session", seq: 2, timestamp: resolved.timestamp },
  ]);
  assert.equal(history.interactions.size, 0);
  assert.equal(history.blocks.get(`tool:${context.runId}:${context.toolCallId}`).approval.scope, "persistent");
});

test("UI rule management validates membership and accepts only documented command arguments", async () => {
  const store = new InMemorySessionStore(), rules = new InMemoryPermissionRuleStore();
  const workspace = await AgentWorkspace.open({ workspace: process.cwd(), store, catalog: new InMemorySessionCatalog(), openApplication: selection => AgentApplication.open({
    ...selection, store, permissionRuleStore: rules, permissionPolicy: policy,
    model: new DeepSeekModel({ apiKey: "unused-for-offline-rule-management", model: "deepseek-chat" }),
  }) });
  const rule = await workspace.createPermissionRule({ tool: toolDefinition, input: {}, context }, { decision: "allow", createdBy: "local-operator" });
  const host = new ApplicationUiHost(workspace, { product, permissionActor: () => "local-operator", permissionRules: {
    list: () => workspace.listPermissionRules(scopeId), revoke: id => workspace.revokePermissionRule(id),
    async create(sourceId, decision) {
      assert.equal((await workspace.listPermissionRules(scopeId)).some(rule => rule.id === sourceId), true);
      return workspace.createPermissionRuleFrom(sourceId, { decision, createdBy: "local-operator" });
    },
  } });
  try {
    const command = (name, args) => ({ version: 1, hostId: host.hostId, requestId: "management", name, targetId: workspace.sessionId, args });
    const snapshot = await host.snapshot();
    assert.equal(snapshot.commands.includes("permission.rules.list"), true);
    assert.equal(snapshot.panels.find(panel => panel.id === "permission-rules").actions[0].command, "permission.rules.list");
    const listing = await host.execute(command("permission.rules.list", {}));
    assert.match(listing.output.text, /local-operator/u);
    assert.match(listing.output.text, /Modify Markdown files under project docs/u);
    assert.equal(listing.output.actions[0].args.id, rule.id);
    await assert.rejects(host.execute(command("permission.rules.revoke", { id: "another-rule" })), /规则不属于当前权限范围/u);
    await assert.rejects(host.execute(command("permission.rules.revoke", { id: rule.id, createdBy: "client" })), /命令参数不正确/u);
    assert.deepEqual(await workspace.listPermissionRules(), [rule]);
    await assert.rejects(host.execute(command("permission.rules.create", { sourceId: "another-rule", decision: "deny" })), /规则不属于当前权限范围/u);
    await assert.rejects(host.execute(command("permission.rules.create", { sourceId: rule.id, decision: "deny", createdBy: "client" })), /命令参数不正确/u);
    await host.execute(command("permission.rules.create", { sourceId: rule.id, decision: "deny" }));
    const created = (await workspace.listPermissionRules()).find(item => item.decision === "deny");
    assert.equal(created.createdBy, "local-operator");
    assert.equal(created.scopeId, rule.scopeId);
    await host.execute(command("permission.rules.revoke", { id: rule.id }));
    await host.execute(command("permission.rules.revoke", { id: created.id }));
    assert.deepEqual(await workspace.listPermissionRules(), []);
  } finally { await host.close(); }
});
