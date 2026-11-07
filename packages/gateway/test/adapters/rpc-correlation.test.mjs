import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTestDirectory } from "@sortedyuan/test-support";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";
import { createGatewayRpcAdapter } from "../../dist/adapters/index.js";
import { defineTool } from "@sortedyuan/may/core";
import { z } from "zod";

const example = fileURLToPath(new URL("../../examples/rpc-file-agent.mjs", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const telemetry = {
  version: 1,
  taskId: "hash-task",
  coordinationId: "file-work",
  dispatchId: "hash-dispatch",
  schedulerExecutionId: "file-schedule",
  parent: { traceId: "1234567890abcdef1234567890abcdef", spanId: "1234567890abcdef", sampled: true },
};
const input = {
  role: "user",
  content: [{ type: "text", text: JSON.stringify({ operation: "sha256", path: "document.txt" }) }],
};
async function workspace(t) {
  const directory = await createTestDirectory(t, "gateway/rpc-correlation");
  await writeFile(join(directory, "document.txt"), "RPC telemetry file calculation");
  return directory;
}
function options(directory) {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [example, "--directory", join(directory, "state"), "--workspace", directory],
  };
}
function context(conversationId, inputId, correlation) {
  return {
    conversationId,
    inputId,
    input,
    signal: new AbortController().signal,
    tools: [],
    shouldYield: () => false,
    report(event) {
      throw new Error(`Unexpected file service event ${event.type}`);
    },
    ...(correlation === undefined ? {} : { telemetry: correlation }),
  };
}
async function client(t, directory) {
  const config = options(directory);
  const child = spawn(config.command, config.args, { windowsHide: true, stdio: "pipe" });
  child.stderr.resume();
  const exited = once(child, "exit");
  await once(child, "spawn");
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  connection.listen();
  t.after(async () => {
    connection.dispose();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  return connection;
}

test("RPC adapter propagates validated correlation and retains completed business identity", async (t) => {
  const directory = await workspace(t);
  const adapter = await createGatewayRpcAdapter("files", options(directory));
  t.after(() => adapter.close());
  const conversationId = await adapter.createConversation("correlated-file"),
    inputId = "hash-input";
  const first = await adapter.execute(context(conversationId, inputId, telemetry));
  assert.equal(first.text, hash("RPC telemetry file calculation"));
  const recordPath = join(directory, "state", `${conversationId}-${hash(inputId)}.json`);
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  assert.deepEqual(record.telemetry, telemetry);
  assert.equal(record.inputHash, hash(JSON.stringify(input)));
  await writeFile(join(directory, "document.txt"), "Content changed after the completed request");
  const repeated = await adapter.execute(
    context(conversationId, inputId, { ...telemetry, parent: { ...telemetry.parent, spanId: "abcdef1234567890" } }),
  );
  assert.deepEqual(repeated, first);
  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), record);
  await assert.rejects(
    adapter.execute(context(conversationId, "invalid-local", { ...telemetry, version: 2 })),
    /Unsupported telemetry correlation format/,
  );
  assert.equal((await adapter.inspect(conversationId, "invalid-local")).status, "not-started");
});

test("actual RPC receiver rejects invalid telemetry before starting file work", async (t) => {
  const directory = await workspace(t),
    connection = await client(t, directory);
  const handshake = await connection.sendRequest("gateway/initialize", {
    protocolVersion: 1,
    agentId: "files",
    telemetryVersion: 1,
  });
  assert.equal(handshake.telemetryVersion, 1);
  const { conversationId } = await connection.sendRequest("conversation/create", {
    requestId: "invalid-remote-envelope",
  });
  for (const [inputId, invalid] of [
    ["unsupported", { ...telemetry, version: 2 }],
    ["unbounded", { ...telemetry, taskId: "x".repeat(257) }],
    ["unexpected", { ...telemetry, prompt: "private document" }],
  ]) {
    await assert.rejects(
      connection.sendRequest("conversation/execute", { conversationId, inputId, input, telemetry: invalid }),
      /telemetry correlation/,
    );
    assert.equal(
      (await connection.sendRequest("conversation/inspect", { conversationId, inputId })).status,
      "not-started",
    );
  }
  assert.equal(
    (await connection.sendRequest("conversation/execute", { conversationId, inputId: "valid", input, telemetry })).text,
    hash("RPC telemetry file calculation"),
  );
});

test("actual RPC file service supports clients without telemetry negotiation", async (t) => {
  const directory = await workspace(t),
    connection = await client(t, directory);
  const handshake = await connection.sendRequest("gateway/initialize", { protocolVersion: 1, agentId: "files" });
  assert.equal(handshake.telemetryVersion, undefined);
  const { conversationId } = await connection.sendRequest("conversation/create", { requestId: "legacy-file" });
  await assert.rejects(
    connection.sendRequest("conversation/execute", { conversationId, inputId: "unnegotiated", input, telemetry }),
    /has not been negotiated/,
  );
  assert.equal(
    (await connection.sendRequest("conversation/inspect", { conversationId, inputId: "unnegotiated" })).status,
    "not-started",
  );
  assert.equal(
    (await connection.sendRequest("conversation/execute", { conversationId, inputId: "legacy-input", input })).text,
    hash("RPC telemetry file calculation"),
  );
  const record = JSON.parse(
    await readFile(join(directory, "state", `${conversationId}-${hash("legacy-input")}.json`), "utf8"),
  );
  assert.equal(Object.hasOwn(record, "telemetry"), false);
});

test(
  "RPC coalesces duplicate tool calls while asynchronous schema validation is pending",
  { timeout: 10_000 },
  async (t) => {
    const parsing = Promise.withResolvers();
    const release = Promise.withResolvers();
    const callbacksProcessed = Promise.withResolvers();
    let parseCount = 0;
    let executionCount = 0;
    let peer;
    let socket;
    const progress = [];
    const server = createServer((accepted) => {
      socket = accepted;
      peer = createMessageConnection(new StreamMessageReader(accepted), new StreamMessageWriter(accepted));
      peer.onRequest("gateway/initialize", () => ({
        protocolVersion: 1,
        capabilities: {
          cancel: false,
          steer: false,
          resume: false,
          delete: false,
          approvals: false,
          collaboration: true,
          media: [],
        },
      }));
      peer.onRequest("conversation/execute", async ({ conversationId, inputId }) => {
        const request = { conversationId, inputId, callId: "sum", step: 0, name: "add", input: { left: 2, right: 3 } };
        const first = peer.sendRequest("gateway/tool", request);
        const second = peer.sendRequest("gateway/tool", request);
        const results = Promise.all([first, second]);
        await peer.sendRequest("gateway/shouldYield", { conversationId, inputId });
        callbacksProcessed.resolve();
        return { text: JSON.stringify(await results) };
      });
      peer.onNotification("gateway/toolProgress", (update) => progress.push(update));
      peer.listen();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      release.resolve();
      peer?.dispose();
      socket?.destroy();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const adapter = await createGatewayRpcAdapter("arithmetic", {
      transport: "socket",
      host: "127.0.0.1",
      port: server.address().port,
    });
    t.after(() => adapter.close());
    const defined = defineTool({
      name: "add",
      description: "Add two integers",
      schema: z.object({ left: z.number().int(), right: z.number().int() }).transform(async (value) => {
        parsing.resolve();
        await release.promise;
        return value;
      }),
      async execute(value, context) {
        executionCount++;
        assert.equal(Object.isFrozen(value), true);
        context.report({ type: "progress", message: "Adding integers" });
        return value.left + value.right;
      },
    });
    const tool = {
      ...defined,
      parse(value) {
        parseCount++;
        return defined.parse(value);
      },
    };
    const execution = adapter.execute({ ...context("sum-conversation", "sum-input"), tools: [tool] });
    await Promise.all([parsing.promise, callbacksProcessed.promise]);
    assert.equal(parseCount, 1);
    assert.equal(executionCount, 0);
    release.resolve();
    assert.deepEqual(JSON.parse((await execution).text), [5, 5]);
    assert.equal(parseCount, 1);
    assert.equal(executionCount, 1);
    assert.equal(progress.length, 1);
  },
);
