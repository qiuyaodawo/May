import assert from "node:assert/strict";
import test from "node:test";
import { openMcpClientPool, mcpAppSandboxResponse, parseMcpAppResource, MCP_APP_MIME } from "../dist/index.js";
import { PermissionToolExecutor } from "../../permissions/dist/index.js";
import { executeMaybeCodeSlashCommand } from "../../../apps/maybecode/dist/index.js";
import { startCatalogFixture } from "./fixtures/catalog-server.mjs";

const owner = { workspaceId: "workspace", sessionId: "session" };
const tool = (name, visibility) => ({ name, description: name, inputSchema: { type: "object" }, _meta: { ui: { visibility, resourceUri: "ui://app/main" } } });
const init = { jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "test", version: "1" }, appCapabilities: {} } };
const initialized = { jsonrpc: "2.0", method: "ui/notifications/initialized" };

test("Apps isolate same-server tools and consented resources, filter model visibility and revoke stale views", async (t) => {
  const fixture = await startCatalogFixture(t);
  fixture.state.tools = [tool("visible", ["model", "app"]), tool("private", ["app"]), tool("model-only", ["model"]), tool("invalid", ["unknown"])];
  fixture.state.input = (m) => m.method === "resources/read" && m.params.uri.startsWith("ui://")
    ? { contents: [{ uri: m.params.uri, mimeType: MCP_APP_MIME, text: "<!doctype html><p>App</p>" }] } : undefined;
  let allowed = false; const checks = []; const approvals = [];
  const executor = new PermissionToolExecutor({ policy: (check) => { checks.push(check); return allowed ? "allow" : "deny"; } });
  t.after(() => executor.close());
  const pool = await openMcpClientPool({ servers: [{ id: "remote", transport: "streamable-http", url: fixture.url + "/modern" }],
    apps: { executor, approve: async (request) => { approvals.push(request); return true; } } });
  t.after(() => pool.close());
  assert.equal(pool.tools.length, 2); assert.equal(pool.catalog()[0].tools.length, 4);
  const app = await pool.openApp("remote", "visible", { owner });
  assert.equal(approvals[0].kind, "open");
  assert.equal((await app.receive(init)).result.protocolVersion, "2026-01-26"); await app.receive(initialized);
  const call = (id, name) => app.receive({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {}, owner: { sessionId: "evil" } } });
  assert.ok((await call(2, "private")).error);
  assert.equal(fixture.requests.filter((r) => r.message?.method === "tools/call").length, 0);
  allowed = true; assert.ok((await call(3, "private")).result);
  assert.deepEqual(checks.at(-1).context.scope, owner);
  for (const [id, name] of [[4, "model-only"], [5, "mcp__other__private"], [6, "invalid"]]) assert.ok((await call(id, name)).error);
  assert.ok((await app.receive({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "file:///secret" } })).error);
  assert.ok((await app.receive({ jsonrpc: "2.0", id: 8, method: "resources/read", params: { uri: "test:///first" } })).result);
  assert.equal(approvals.at(-1).kind, "read");
  assert.equal((await app.receive({ jsonrpc: "2.0", id: 9, method: "ui/message", params: { content: [] } })).error.code, -32601);
  fixture.state.tools[0].description = "changed"; await pool.refresh();
  assert.ok((await call(10, "private")).error);
  await assert.rejects(app.notification("tool-result", { content: [] }));
  app.close();
  const fallback = await executeMaybeCodeSlashCommand("/mcp apps", {});
  assert.match(fallback.text, /not supported in this terminal/u);
  assert.throws(() => parseMcpAppResource("ui://app/main", { contents: [{ uri: "ui://other", mimeType: MCP_APP_MIME, text: "<!doctype html>" }] }));
  const response = mcpAppSandboxResponse("http://127.0.0.1:3000");
  assert.match(response.headers["content-security-policy"], /connect-src 'none'/u);
  assert.throws(() => mcpAppSandboxResponse("https://host.example/"));
  // A custom consent service ignoring signal cannot keep an opening view alive.
  let reached; const reviewing = new Promise((resolve) => { reached = resolve; });
  const stalled = await openMcpClientPool({ servers: [{ id: "remote", transport: "streamable-http", url: fixture.url + "/modern" }],
    apps: { executor, approve: async () => { reached(); return new Promise(() => {}); } } });
  t.after(() => stalled.close());
  const abort = new AbortController();
  const opening = assert.rejects(stalled.openApp("remote", "visible", { owner, signal: abort.signal }));
  await reviewing; abort.abort(); await opening;
});
