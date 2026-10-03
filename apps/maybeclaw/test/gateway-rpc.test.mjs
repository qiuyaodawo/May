import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createGatewayRpcAdapter, RpcOutcomeUnknownError } from "../dist/gateway-rpc-adapter.js";
import { AgentGateway } from "../dist/gateway.js";
import { gatewaySettings } from "../dist/gateway-settings.js";

const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
async function directory(t) {
  const root = fileURLToPath(new URL("../../../.zcode/tmp/rpc-tests/", import.meta.url));
  await mkdir(root, { recursive: true });
  const path = await mkdtemp(join(root, "files-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const input = (conversationId, inputId, operation, path, signal = new AbortController().signal) => ({ conversationId, inputId, input: { role: "user", content: [{ type: "text", text: JSON.stringify({ operation, path }) }] }, signal, tools: [], shouldYield: () => false, report: () => {} });
async function until(probe) { for (let attempt = 0; attempt < 100; attempt++) { if (await probe()) return; await delay(20); } throw new Error("Condition timed out"); }

function fileGateway(path) {
  const configPath = join(path, "config.json");
  const settings = gatewaySettings({ path: configPath, providers: {}, models: {}, apps: { maybeclaw: { version: 2,
    agents: [{ id: "files", adapter: "module", module: "@may/plugin-agent-adapters/rpc", options: {
      transport: "stdio", command: process.execPath, args: [example, "--directory", join(path, "state"), "--workspace", path],
    } }],
  } } });
  return new AgentGateway({ directory: path, configPath, settings });
}

test("Gateway 关闭后拒绝创建尚未初始化的 RPC adapter", async t => {
  const path = await directory(t), gateway = fileGateway(path);
  t.after(() => gateway.close());
  assert.equal(gateway.status().agents[0].status, "unloaded");
  await gateway.close();
  await assert.rejects(gateway.adapter("files"), /Gateway is closing/);
  await assert.rejects(access(join(path, "state")), error => error.code === "ENOENT");
});

test("Gateway 关闭期间拒绝获取 adapter 并终止已创建的 RPC 进程", async t => {
  const path = await directory(t), gateway = fileGateway(path);
  t.after(() => gateway.close());
  const adapter = await gateway.adapter("files"), conversation = await adapter.createConversation("before-close");
  const { pid } = JSON.parse(await adapter.command(conversation, "process", []));
  process.kill(pid, 0);
  const closing = gateway.close();
  await assert.rejects(gateway.adapter("files"), /Gateway is closing/);
  await closing;
  assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
});

test("stdio RPC 进程执行实际文件计算并按请求 ID 恢复对话", async t => {
  const path = await directory(t), options = { transport: "stdio", command: process.execPath, args: [example, "--directory", join(path, "state"), "--workspace", path] };
  const content = "MaybeClaw 外部 Agent 文件检查\n";
  await writeFile(join(path, "readme.txt"), content);
  let adapter = await createGatewayRpcAdapter("files", options);
  t.after(() => adapter.close());
  assert.equal(adapter.capabilities.cancel, true);
  const conversation = await adapter.createConversation("request-one");
  assert.equal(await adapter.createConversation("request-one"), conversation);
  assert.deepEqual(await adapter.inspectCreation("request-one"), { status: "ready", conversationId: conversation });
  assert.equal((await adapter.inspectCreation("absent")).status, "not-started");
  const result = await adapter.execute(input(conversation, "hash-one", "sha256", "readme.txt"));
  assert.equal(result.text, createHash("sha256").update(content).digest("hex"));
  assert.equal((await adapter.inspect(conversation, "hash-one")).status, "completed");
  await adapter.close();
  adapter = await createGatewayRpcAdapter("files", options);
  assert.equal(await adapter.createConversation("request-one"), conversation);
  assert.equal((await adapter.inspect(conversation, "hash-one")).text, result.text);
  await assert.rejects(adapter.command(conversation, "new", []), /Unsupported/);
  assert.equal(await adapter.command(conversation, "status", []), "idle");
  await adapter.release(conversation);
  await adapter.deleteConversation(conversation);
  assert.equal((await adapter.inspectCreation("request-one")).status, "not-started");
});

test("取消一个对话的文件等待保持共享 RPC 进程和其他对话可用", async t => {
  const path = await directory(t);
  const adapter = await createGatewayRpcAdapter("files", { transport: "stdio", command: process.execPath, args: [example, "--directory", join(path, "state"), "--workspace", path] });
  t.after(() => adapter.close());
  const first = await adapter.createConversation("first"), second = await adapter.createConversation("second");
  const cancellation = new AbortController();
  const work = adapter.execute(input(first, "waiting", "waitForFile", "arriving.txt", cancellation.signal));
  const rejected = assert.rejects(work, /Cancelled by Gateway/);
  await until(async () => (await adapter.inspect(first, "waiting")).status === "running");
  cancellation.abort();
  await rejected;
  assert.equal((await adapter.inspect(first, "waiting")).status, "cancelled");
  await writeFile(join(path, "other.txt"), "other conversation");
  assert.equal((await adapter.execute(input(second, "compute", "sha256", "other.txt"))).text, createHash("sha256").update("other conversation").digest("hex"));
  const waiting = adapter.execute(input(first, "wait-again", "waitForFile", "arriving.txt"));
  await until(async () => (await adapter.inspect(first, "wait-again")).status === "running");
  await writeFile(join(path, "arriving.txt"), "ready");
  assert.match((await waiting).text, /File is available/);
});

test("socket RPC 超时保留未知结果，重新连接查询并取消原请求", async t => {
  const path = await directory(t);
  const socketPath = process.platform === "win32" ? `\\\\.\\pipe\\maybeclaw-${randomUUID()}` : join(path, "agent.sock");
  const child = spawn(process.execPath, [example, "--directory", join(path, "state"), "--workspace", path, "--socket", socketPath], { stdio: "ignore", windowsHide: true, shell: false });
  await once(child, "spawn");
  t.after(async () => { if (child.exitCode === null) { const stopped = once(child, "exit"); child.kill(); await stopped; } });
  await until(() => new Promise(resolve => { const socket = connect(socketPath); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); }));
  let adapter = await createGatewayRpcAdapter("files", { transport: "socket", path: socketPath, executionTimeoutMs: 75 });
  t.after(() => adapter.close());
  const conversation = await adapter.createConversation("socket-work");
  await assert.rejects(adapter.execute(input(conversation, "long-running", "waitForFile", "pending.txt")), error => error instanceof RpcOutcomeUnknownError && error.requestId === "long-running");
  await adapter.close();
  assert.equal(child.exitCode, null);
  adapter = await createGatewayRpcAdapter("files", { transport: "socket", path: socketPath });
  assert.equal((await adapter.inspect(conversation, "long-running")).status, "running");
  await adapter.cancel(conversation);
  assert.equal((await adapter.inspect(conversation, "long-running")).status, "cancelled");
  await access(join(path, "state"));
});

test("外部进程中断后查询自动重新握手并恢复已保存的请求状态", async t => {
  const path = await directory(t);
  const adapter = await createGatewayRpcAdapter("files", { transport: "stdio", command: process.execPath, args: [example, "--directory", join(path, "state"), "--workspace", path] });
  t.after(() => adapter.close());
  const conversation = await adapter.createConversation("interrupted-process");
  const pending = adapter.execute(input(conversation, "pending-work", "waitForFile", "pending.txt"));
  const unknown = assert.rejects(pending, error => error instanceof RpcOutcomeUnknownError && error.requestId === "pending-work");
  await until(async () => (await adapter.inspect(conversation, "pending-work")).status === "running");
  const { pid } = JSON.parse(await adapter.command(conversation, "process", []));
  assert.ok(Number.isSafeInteger(pid) && pid !== process.pid);
  process.kill(pid);
  await unknown;
  const status = await adapter.inspect(conversation, "pending-work");
  assert.equal(status.status, "recovery-required");
  assert.deepEqual(await adapter.inspectCreation("interrupted-process"), { status: "ready", conversationId: conversation });
  assert.notEqual(JSON.parse(await adapter.command(conversation, "process", [])).pid, pid);
});

test("RPC补充信息保留到文件步骤结束，并提供持久状态查询", async t => {
  const path = await directory(t), options = { transport: "stdio", command: process.execPath, args: [example, "--directory", join(path, "state"), "--workspace", path] };
  let adapter = await createGatewayRpcAdapter("files", options);
  t.after(() => adapter.close());
  const conversation = await adapter.createConversation("steering-work");
  const waiting = adapter.execute(input(conversation, "wait-step", "waitForFile", "ready.txt"));
  await until(async () => (await adapter.inspect(conversation, "wait-step")).status === "running");
  const text = JSON.stringify({ operation: "sha256", path: "ready.txt" });
  assert.equal((await adapter.steer(conversation, text, "follow-up")).status, "pending");
  assert.deepEqual(await adapter.steeringInputs(conversation), [{ inputId: "follow-up", text, status: "pending" }]);
  await writeFile(join(path, "ready.txt"), "arrived");
  await waiting;
  assert.equal((await adapter.steeringInputs(conversation))[0].status, "idle");
  await adapter.close();
  adapter = await createGatewayRpcAdapter("files", options);
  assert.equal((await adapter.steeringInputs(conversation))[0].status, "idle");
  assert.equal((await adapter.execute(input(conversation, "follow-up", "sha256", "ready.txt"))).text, createHash("sha256").update("arrived").digest("hex"));
  assert.equal((await adapter.steeringInputs(conversation))[0].status, "delivered");
});
