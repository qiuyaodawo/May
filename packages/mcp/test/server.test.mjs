import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createMayMcpServer, createMayMcpBearerAuthenticator } from "../dist/server.js";
import { openMcpClientPool } from "../dist/index.js";
import { PermissionToolExecutor } from "../../permissions/dist/index.js";

test("independent HTTP export authenticates and isolates principals, filters capabilities and uses the normal permission pipeline", { timeout: 10_000 }, async (t) => {
  const token = "a".repeat(40); const otherToken = "b".repeat(40); const wrongToken = "c".repeat(40);
  const auth = createMayMcpBearerAuthenticator([{ token, principal: { id: "alice", workspaceId: "one" } },
    { token: otherToken, principal: { id: "bob", workspaceId: "one" } }, { token: wrongToken, principal: { id: "outsider", workspaceId: "two" } }]);
  let allow = false; let ask = false; let executions = 0; const contexts = [];
  const executor = new PermissionToolExecutor({ policy: (check) => { contexts.push(check.context); return ask ? "ask" : allow ? "allow" : "deny"; } });
  t.after(() => executor.close());
  let exported;
  const http = createServer(async (req, res) => {
    const abort = new AbortController(); res.on("close", () => abort.abort());
    try {
      const request = new Request(`http://127.0.0.1:${http.address().port}${req.url}`, { method: req.method, headers: req.headers,
        ...(req.method === "POST" ? { body: req, duplex: "half" } : {}), signal: abort.signal });
      const response = await exported.fetch(request); res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end(); }
  });
  http.listen(0, "127.0.0.1"); await once(http, "listening");
  t.after(() => { http.close(); http.closeAllConnections(); });
  const endpoint = `http://127.0.0.1:${http.address().port}/mcp`;
  exported = createMayMcpServer({ endpoint, workspaceId: "one", authenticate: auth.authenticate, executor,
    authorize: async ({ principal, target }) => target === undefined || principal.id === "alice",
    tools: [{ tool: { name: "run", description: "Explicit export", inputSchema: { type: "object", properties: { value: { type: "integer" } }, required: ["value"] },
      async execute(input, context) { executions++; return { value: input.value, private: "host-private-value", scope: context.scope }; } },
      result: (output) => ({ content: [{ type: "text", text: JSON.stringify({ value: output.value, scope: output.scope }) }] }) }],
    resources: [{ definition: { uri: "may://public/config", name: "config" }, read: async ({ principal }) => ({ contents: [{ uri: "may://public/config", text: principal.id }] }) }],
    prompts: [{ definition: { name: "review", arguments: [{ name: "topic", required: true }] }, get: async (args) => ({ messages: [{ role: "user", content: { type: "text", text: args.topic } }] }) }],
  });
  t.after(() => exported.close());
  assert.equal((await fetch(endpoint, { method: "POST" })).status, 401);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${wrongToken}` } })).status, 403);
  assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: "https://evil.example" } })).status, 403);
  const open = (token) => openMcpClientPool({ servers: [{ id: "export", transport: "streamable-http", url: endpoint, headers: { authorization: `Bearer ${token}` } }] });
  const alice = await open(token); t.after(() => alice.close()); const bob = await open(otherToken); t.after(() => bob.close());
  assert.equal(alice.tools.length, 1); assert.equal(bob.tools.length, 0); assert.equal(bob.catalog()[0].resources.length, 0); assert.equal(bob.catalog()[0].prompts.length, 0);
  const tool = alice.tools[0];
  const context = { runId: "untrusted-run", step: 1, toolCallId: "caller", idempotencyKey: "caller", scope: { workspaceId: "two", sessionId: "stolen" }, signal: new AbortController().signal, report() {} };
  await assert.rejects(tool.execute({ value: 1 }, context)); assert.equal(executions, 0);
  allow = true; const result = await tool.execute({ value: 2 }, context);
  assert.doesNotMatch(JSON.stringify(result), /host-private-value|stolen|untrusted-run/u);
  assert.equal(contexts.at(-1).scope.workspaceId, "one"); assert.equal(contexts.at(-1).scope.principalId, "alice");
  await assert.rejects(tool.execute({ value: "bad" }, context)); assert.equal(executions, 1);
  assert.equal((await alice.readResource("export", "may://public/config")).result.contents[0].text, "alice");
  assert.equal((await alice.getPrompt("export", "review", { topic: "Inspect" })).result.messages[0].content.text, "Inspect");
  await assert.rejects(bob.readResource("export", "may://public/config"));
  await assert.rejects(alice.readResource("export", "file:///host-history"));
  assert.equal((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ method: "ping", padding: "x".repeat(1024 * 1024) }) })).status, 400);
  ask = true;
  executor.setEventSink(async (event) => { if (event.type === "approval.requested") { auth.revoke(token); await executor.resolve(event.request.id, "allow"); } });
  await assert.rejects(tool.execute({ value: 3 }, context)); assert.equal(executions, 1);
  await exported.close(); assert.equal((await exported.fetch(new Request(endpoint, { method: "POST" }))).status, 503);
});

test("independent stdio export binds launcher identity and serves modern or explicitly selected legacy clients", { timeout: 10_000 }, async (t) => {
  for (const legacy of [false, true]) {
  const pool = await openMcpClientPool({ servers: [{ id: "stdio", command: process.execPath, protocolMode: legacy ? "legacy" : "auto", args: [fileURLToPath(new URL("./fixtures/export-server.mjs", import.meta.url)), ...(legacy ? ["--legacy"] : [])] }] });
  t.after(() => pool.close()); assert.equal(pool.status()[0].protocolVersion, legacy ? "2025-11-25" : "2026-07-28");
  const result = await pool.tools[0].execute({}, { runId: "foreign", toolCallId: "foreign", idempotencyKey: "foreign", step: 1, signal: new AbortController().signal, report() {} });
  const scope = JSON.parse(result.content[0].text); assert.equal(scope.principalId, "local-launcher"); assert.equal(scope.workspaceId, "stdio-workspace");
  await pool.close();
  }
});
