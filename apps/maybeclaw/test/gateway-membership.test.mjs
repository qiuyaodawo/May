import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { AgentGateway } from "../dist/gateway.js";
import { GatewayHost } from "../dist/gateway-host.js";
import { ChannelStore, inboxId } from "../dist/channel-store.js";
import { gatewaySettings } from "../dist/gateway-settings.js";

const base = fileURLToPath(new URL("../../../.zcode/tmp/gateway-membership/", import.meta.url));
const module = fileURLToPath(new URL("../dist/gateway-rpc-adapter.js", import.meta.url));
const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
const operator = { kind: "operator", id: "membership-verification" };
const entry = { kind: "group", account: "telegram:42", conversation: "-10012" };
const member = { kind: "platform", account: entry.account, conversation: entry.conversation, userId: "7" };

async function until(probe) {
  for (let attempt = 0; attempt < 200; attempt++) { const result = await probe(); if (result) return result; await delay(20); }
  throw new Error("Member access verification timed out");
}

async function setup(t, noCancel) {
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "case-"));
  const settings = gatewaySettings({ apps: { maybeclaw: { version: 2, server: { shutdownMs: 500 }, agents: [{ id: "files", adapter: "module", module,
    options: { transport: "stdio", command: process.execPath, args: [example, "--directory", join(directory, "rpc"), "--workspace", directory, ...(noCancel ? ["--no-cancel"] : [])] } }] } } });
  const gateway = new AgentGateway({ directory: join(directory, "gateway"), configPath: join(directory, "config.json"), settings });
  const channels = await ChannelStore.open(join(directory, "gateway", "gateway-channels.jsonl"));
  const host = new GatewayHost({ gateway, adapters: [] }, channels);
  t.after(async () => {
    await writeFile(join(directory, "ready.txt"), "operation may finish");
    await host.close();
    assert.ok(resolve(directory).startsWith(resolve(base) + sep));
    await rm(directory, { recursive: true, force: true });
  });
  const session = gateway.createSession(operator, "members", ["files"], [], entry);
  const receipt = await gateway.handle(JSON.stringify({ operation: "waitForFile", path: "ready.txt" }), member, { requestId: "active-work", sessionId: session.id });
  const taskId = receipt.taskIds[0], adapter = await gateway.adapter("files");
  const binding = await until(async () => {
    const task = gateway.store.get("tasks", taskId), binding = gateway.store.get("bindings", `${session.id}:files`);
    return task?.status === "running" && binding?.conversationId && (await adapter.inspect(binding.conversationId, task.inputId)).status === "running" && binding;
  });
  const event = { ...entry, sender: member.userId, eventId: "left", eventType: "member-left", occurredAt: "1790000000000", text: "" };
  gateway.store.put("inbox", inboxId(event), { id: inboxId(event), input: event, state: "pending" });
  const joined = { ...event, conversation: "-10013", sender: "8", eventId: "joined", eventType: "member-joined" };
  gateway.store.put("inbox", inboxId(joined), { id: inboxId(joined), input: joined, state: "pending" });
  return { gateway, host, directory, session, taskId, adapter, binding, event, joined };
}

test("无法取消的实际RPC执行保留运行状态，成员撤权不阻止其他入口处理", async t => {
  const { gateway, host, directory, session, taskId, adapter, binding, event, joined } = await setup(t, true);
  assert.equal(adapter.capabilities.cancel, false);
  await host.tick();
  assert.equal(gateway.canAccess(session, member), false);
  assert.equal(gateway.store.get("inbox", inboxId(event)).state, "done");
  assert.equal(gateway.store.get("inbox", inboxId(joined)).state, "done");
  assert.equal(gateway.store.get("tasks", taskId).status, "running");
  assert.equal((await adapter.inspect(binding.conversationId, gateway.store.get("tasks", taskId).inputId)).status, "running");
  assert.ok(gateway.messages(session.id, operator).some(message => message.taskId === taskId && /不支持取消.*仍在执行/.test(message.text)));
  await assert.rejects(gateway.handle("request after departure", member, { requestId: "after-departure", sessionId: session.id }), /无权访问/);
  await writeFile(join(directory, "ready.txt"), "finished independently");
  await until(() => gateway.store.get("tasks", taskId).status === "completed");
  assert.match(gateway.store.get("tasks", taskId).result, /File is available/);
});

test("实际RPC进程终止时成员撤权保留待核对结果，并完成其他成员事件", async t => {
  const { gateway, host, session, taskId, adapter, binding, event, joined } = await setup(t, false);
  const { pid } = JSON.parse(await adapter.command(binding.conversationId, "process", []));
  assert.ok(Number.isSafeInteger(pid) && pid !== process.pid);
  process.kill(pid);
  await host.tick();
  assert.equal(gateway.canAccess(session, member), false);
  assert.equal(gateway.store.get("inbox", inboxId(event)).state, "done");
  assert.equal(gateway.store.get("inbox", inboxId(joined)).state, "done");
  await until(() => gateway.store.get("tasks", taskId).status === "recovery-required");
  assert.ok(gateway.messages(session.id, operator).some(message => message.taskId === taskId && /访问权限已撤销.*尚未确认/.test(message.text)));
});
