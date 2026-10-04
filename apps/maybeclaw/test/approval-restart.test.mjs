import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";

const parent = fileURLToPath(new URL("../../../review/approval-restart/", import.meta.url));
const operator = { kind: "operator", id: "review" };
const entry = { account: "telegram:42", conversation: "-100", kind: "group" };
const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "7" };

if (process.argv[2] === "--child") {
  const directory = process.argv[3];
  const configPath = join(directory, "config.json");
  const settings = gatewaySettings(JSON.parse(await readFile(configPath, "utf8")));
  const gateway = new AgentGateway({ directory, configPath, settings });
  const session = gateway.createSession(operator, "审批恢复", ["code"], [], entry);
  await gateway.handle("/agent create reviewer", member, { requestId: "create-reviewer", sessionId: session.id, entry });
  const approval = gateway.store.list("approvals")[0];
  assert.equal(approval.status, "pending");
  gateway.observe(() => {
    const current = gateway.store.get("approvals", approval.id);
    if (current.status === "resolving" && gateway.status().agents.find(agent => agent.id === "reviewer").status === "loading") {
      process.exit(71);
    }
  });
  await gateway.resolveApproval(approval.id, operator, "allow");
  throw new Error("审批交付过程中未终止子进程");
} else {
  test("审批交付期间终止进程后保留审批决定，并及时拒绝存在不确定审批的 Agent 更新", { timeout: 10_000 }, async t => {
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(join(parent, "gateway-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const configPath = join(directory, "config.json");
    const example = fileURLToPath(new URL("../../../packages/plugins/agent-adapters/examples/rpc-file-agent.mjs", import.meta.url));
    const reviewer = { id: "reviewer", adapter: "module", module: "@may/plugin-agent-adapters/rpc", options: {
      transport: "stdio", command: process.execPath,
      args: [example, "--directory", join(directory, "rpc-state"), "--workspace", directory],
    } };
    const config = { apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }, reviewer] } } };
    await writeFile(configPath, JSON.stringify(config));
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", directory], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 71, stderr);
    const owner = JSON.parse(await readFile(join(directory, "host.lock"), "utf8"));
    assert.equal(owner.pid, child.pid);
    assert.throws(() => process.kill(owner.pid, 0), { code: "ESRCH" });
    await unlink(join(directory, "host.lock"));
    const options = { directory, configPath, settings: gatewaySettings(config) };
    const gateway = new AgentGateway(options);
    t.after(() => gateway.close());
    const saved = gateway.store.list("approvals")[0];
    assert.equal(saved.status, "unknown");
    assert.equal(saved.decision, "allow");
    assert.deepEqual(saved.decidedBy, operator);
    await gateway.restore();
    await gateway.maintain();
    assert.deepEqual(gateway.store.get("approvals", saved.id), saved);
    const updating = gateway.updateAgent("reviewer", operator, { ...reviewer, name: "updated reviewer" });
    const result = await Promise.race([
      updating.then(() => ({ completed: true }), error => ({ error })),
      delay(1000).then(() => ({ waiting: true })),
    ]);
    assert.match(result.error?.message ?? "", /需要核对的审批结果/u);
    await assert.rejects(gateway.resolveApproval(saved.id, operator, "allow"), /审批已经处理/u);
    await gateway.close();
    const reopened = new AgentGateway(options);
    try { assert.deepEqual(reopened.store.get("approvals", saved.id), saved); }
    finally { await reopened.close(); }
  });
}
