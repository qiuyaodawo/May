import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { createGatewayRpcAdapter } from "../dist/index.js";

const example = fileURLToPath(new URL("../examples/rpc-file-agent.mjs", import.meta.url));
const hash = value => createHash("sha256").update(value).digest("hex");
const telemetry = { version: 1, taskId: "hash-task", coordinationId: "file-work", dispatchId: "hash-dispatch", schedulerExecutionId: "file-schedule",
  parent: { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", sampled: true } };
const input = { role: "user", content: [{ type: "text", text: JSON.stringify({ operation: "sha256", path: "document.txt" }) }] };
async function workspace(t) {
  const base = fileURLToPath(new URL("../../../../review/rpc-correlation-tests/", import.meta.url));
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "hash-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "document.txt"), "RPC telemetry file calculation");
  return directory;
}
function options(directory) {
  return { transport: "stdio", command: process.execPath,
    args: [example, "--directory", join(directory, "state"), "--workspace", directory] };
}
function context(conversationId, inputId, correlation) {
  return { conversationId, inputId, input, signal: new AbortController().signal, tools: [], shouldYield: () => false,
    report(event) { throw new Error(`Unexpected file service event ${event.type}`); }, ...(correlation === undefined ? {} : { telemetry: correlation }) };
}
async function client(t, directory) {
  const config = options(directory);
  const child = spawn(config.command, config.args, { windowsHide: true, stdio: "pipe" });
  child.stderr.resume();
  const exited = once(child, "exit");
  await once(child, "spawn");
  const connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  connection.listen();
  t.after(async () => { connection.dispose(); if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  return connection;
}

test("RPC adapter propagates validated correlation and retains completed business identity", async t => {
  const directory = await workspace(t);
  const adapter = await createGatewayRpcAdapter("files", options(directory));
  t.after(() => adapter.close());
  const conversationId = await adapter.createConversation("correlated-file"), inputId = "hash-input";
  const first = await adapter.execute(context(conversationId, inputId, telemetry));
  assert.equal(first.text, hash("RPC telemetry file calculation"));
  const recordPath = join(directory, "state", `${conversationId}-${hash(inputId)}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.deepEqual(record.telemetry, telemetry);
  assert.equal(record.inputHash, hash(JSON.stringify(input)));
  await writeFile(join(directory, "document.txt"), "Content changed after the completed request");
  const repeated = await adapter.execute(context(conversationId, inputId, { ...telemetry, parent: { ...telemetry.parent, spanId: "abcdef1234567890" } }));
  assert.deepEqual(repeated, first);
  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), record);
  await assert.rejects(adapter.execute(context(conversationId, "invalid-local", { ...telemetry, version: 2 })), /Unsupported telemetry correlation format/);
  assert.equal((await adapter.inspect(conversationId, "invalid-local")).status, "not-started");
});

test("actual RPC receiver rejects invalid telemetry before starting file work", async t => {
  const directory = await workspace(t), connection = await client(t, directory);
  const handshake = await connection.sendRequest("gateway/initialize", { protocolVersion: 1, agentId: "files", telemetryVersion: 1 });
  assert.equal(handshake.telemetryVersion, 1);
  const { conversationId } = await connection.sendRequest("conversation/create", { requestId: "invalid-remote-envelope" });
  for (const [inputId, invalid] of [["unsupported", { ...telemetry, version: 2 }], ["unbounded", { ...telemetry, taskId: "x".repeat(257) }],
    ["unexpected", { ...telemetry, prompt: "private document" }]]) {
    await assert.rejects(connection.sendRequest("conversation/execute", { conversationId, inputId, input, telemetry: invalid }), /telemetry correlation/);
    assert.equal((await connection.sendRequest("conversation/inspect", { conversationId, inputId })).status, "not-started");
  }
  assert.equal((await connection.sendRequest("conversation/execute", { conversationId, inputId: "valid", input, telemetry })).text, hash("RPC telemetry file calculation"));
});

test("actual RPC file service supports clients without telemetry negotiation", async t => {
  const directory = await workspace(t), connection = await client(t, directory);
  const handshake = await connection.sendRequest("gateway/initialize", { protocolVersion: 1, agentId: "files" });
  assert.equal(handshake.telemetryVersion, undefined);
  const { conversationId } = await connection.sendRequest("conversation/create", { requestId: "legacy-file" });
  await assert.rejects(connection.sendRequest("conversation/execute", { conversationId, inputId: "unnegotiated", input, telemetry }), /has not been negotiated/);
  assert.equal((await connection.sendRequest("conversation/inspect", { conversationId, inputId: "unnegotiated" })).status, "not-started");
  assert.equal((await connection.sendRequest("conversation/execute", { conversationId, inputId: "legacy-input", input })).text, hash("RPC telemetry file calculation"));
  const record = JSON.parse(await readFile(join(directory, "state", `${conversationId}-${hash("legacy-input")}.json`), "utf8"));
  assert.equal(Object.hasOwn(record, "telemetry"), false);
});
