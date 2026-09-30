import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { loadMayConfig } from "@may/config";
import { AgentGateway } from "../../dist/gateway.js";

const base = fileURLToPath(new URL("../../../../.zcode/tmp/maybeclaw-live-tests/", import.meta.url));
const workspace = fileURLToPath(new URL("../../../../", import.meta.url));
const actor = { kind: "operator", id: "live-verification" };

test("real provider: persistent conversations, defaults, collaboration, steering and interruption", {
  skip: !process.env.MAYBECLAW_LIVE_MODEL,
  timeout: 240_000,
}, async () => {
  const config = await loadMayConfig();
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const settings = { version: 2,
    agents: ["writer", "reviewer", "reader"].map(id => ({ id, adapter: "may", model: process.env.MAYBECLAW_LIVE_MODEL,
      instructions: "Use supplied tools exactly when requested. Only delegate when explicitly requested. Keep final answers short.",
      ...(id === "reader" ? { readDirectory: workspace, permissions: { read: "ask" } } : {}),
      runBudget: { maxSteps: 8, maxModelCalls: 8, maxToolCalls: 12, maxDurationMs: 120000 } })),
    access: { sessionAdmins: {}, creators: [], deniedUsers: [], allowedAgents: {} },
    idleMs: 600000, shutdownMs: 10000, approvalMs: 60000, maxConcurrent: 3 };
  let gateway = new AgentGateway({ directory, configPath: config.path, settings });
  let verified = false;
  async function until(check) {
    const deadline = Date.now() + 130000;
    while (Date.now() < deadline) {
      await gateway.maintain();
      const result = check();
      if (result) return result;
      await delay(100);
    }
    throw new Error("Timed out waiting for Gateway state");
  }
  async function finish(receipt) {
    const tasks = await until(() => {
      const values = receipt.taskIds.map(id => gateway.store.get("tasks", id));
      return values.every(task => task && ["completed", "failed", "cancelled", "recovery-required"].includes(task.status)) && values;
    });
    for (const task of tasks) assert.equal(task.status, "completed", task.detail);
    return tasks;
  }
  const approvalFor = receipt => until(() => gateway.store.list("approvals").find(item => receipt.taskIds.includes(item.taskId) && item.status === "pending"));
  try {
    const session = gateway.createSession(actor, "context", ["writer"], ["reviewer"]);
    const nonce = `memory-${randomUUID().slice(0, 8)}`;
    const initial = await finish(await gateway.handle(`Remember this exact value: ${nonce}. Reply only with it.`, actor, { requestId: "remember", sessionId: session.id }));
    assert.ok(initial[0].result.includes(nonce));
    const binding = gateway.store.list("bindings")[0];
    await gateway.close();
    gateway = new AgentGateway({ directory, configPath: config.path, settings });
    await gateway.restore();
    const continued = await finish(await gateway.handle("What exact value did I ask you to remember? Reply only with it.", actor, { requestId: "recall", sessionId: session.id }));
    assert.ok(continued[0].result.includes(nonce));
    assert.equal(gateway.store.list("bindings")[0].conversationId, binding.conversationId);
    gateway.updateSession(session.id, actor, { defaultAgents: ["writer", "reviewer"] });
    const parallel = await finish(await gateway.handle("Reply exactly DEFAULTS_CONFIRMED.", actor, { requestId: "defaults", sessionId: session.id }));
    assert.equal(parallel.length, 2);
    assert.ok(parallel.every(task => task.result.includes("DEFAULTS_CONFIRMED")));
    assert.equal(gateway.store.list("bindings").length, 2);

    const delegated = await finish(await gateway.handle('@writer Use delegate_tasks to delegate exactly one task to agent "reviewer", id "review-one", input "Reply exactly REVIEW_CONFIRMED". After it completes, reply with its result. You must call the tool.', actor, { requestId: "delegate", sessionId: session.id }));
    assert.ok(delegated[0].result.includes("REVIEW_CONFIRMED"));
    assert.ok(gateway.store.list("tasks").some(task => task.graphTaskId === "review-one" && task.agentId === "reviewer" && task.status === "completed"));

    const approvedSession = gateway.createSession(actor, "creation-approval", ["writer"]);
    const approvalReceipt = await gateway.handle('Call list_agents, then use delegate_tasks to delegate exactly one task to "reviewer", id "approved-review", input "Reply exactly APPROVED_REVIEW". Wait for completion and reply with its result.', actor, { requestId: "creation-approval", sessionId: approvedSession.id });
    const creationApproval = await until(() => gateway.store.list("approvals").find(item => item.sessionId === approvedSession.id && item.kind === "create-agent" && item.status === "pending"));
    assert.equal(creationApproval.agentId, "reviewer");
    await gateway.resolveApproval(creationApproval.id, actor, "allow");
    assert.ok((await finish(approvalReceipt))[0].result.includes("APPROVED_REVIEW"));

    const reader = gateway.createSession(actor, "steering", ["reader"]);
    const read = await gateway.handle("Use read to read package.json in the working directory. Follow any supplemental user instructions received while reading.", actor, { requestId: "read", sessionId: reader.id });
    const approval = await approvalFor(read);
    await gateway.handle("/steer After reading the file, reply exactly STEERING_CONFIRMED.", actor, { requestId: "steer", sessionId: reader.id });
    await gateway.resolveApproval(approval.id, actor, "allow");
    const steered = await finish(read);
    assert.ok(steered[0].result.includes("STEERING_CONFIRMED"), JSON.stringify({ result: steered[0].result, steering: gateway.store.list("steering") }));
    assert.ok(gateway.store.list("steering").some(item => item.status === "delivered"));

    const pending = await gateway.handle("Use read to read pnpm-workspace.yaml. Wait for its result before replying.", actor, { requestId: "interrupt-original", sessionId: reader.id });
    const pendingApproval = await approvalFor(pending);
    const replacement = await finish(await gateway.handle("Do not use tools. Reply exactly INTERRUPT_CONFIRMED.", actor, { requestId: "interrupt-new", sessionId: reader.id }));
    assert.ok(replacement[0].result.includes("INTERRUPT_CONFIRMED"));
    assert.equal(gateway.store.get("tasks", pending.taskIds[0]).status, "cancelled");
    assert.equal(gateway.store.get("approvals", pendingApproval.id).status, "cancelled");

    const entry = { kind: "group", account: "integration-channel", conversation: "integration-group" };
    const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "integration-member" };
    const group = gateway.createSession(actor, "group", ["reader"], [], entry);
    const groupInput = await gateway.handle("Use read to read package.json. Wait for its result.", member, { requestId: "member-run", sessionId: group.id, entry });
    const groupApproval = await approvalFor(groupInput);
    await gateway.setMemberAccess(entry, member.userId, false, 200);
    assert.equal(gateway.canAccess(group, member), false);
    assert.equal(gateway.store.get("tasks", groupInput.taskIds[0]).status, "cancelled");
    assert.equal(gateway.store.get("approvals", groupApproval.id).status, "cancelled");
    await gateway.setMemberAccess(entry, member.userId, true, 100);
    assert.equal(gateway.canAccess(group, member), false);
    await gateway.setMemberAccess(entry, member.userId, true, 300);
    assert.equal(gateway.canAccess(group, member), true);
    verified = true;
  } finally {
    await gateway.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    if (verified) await rm(directory, { recursive: true, force: true });
    else console.error(`Verification records: ${directory}`);
  }
});
