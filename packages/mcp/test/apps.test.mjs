import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
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
});

test("Apps double iframe enforces browser origin/CSP isolation and tears down the channel", { skip: !process.env.MAY_PLAYWRIGHT_MODULE, timeout: 20_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.MAY_PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true, ...(process.env.MAY_CHROMIUM_PATH ? { executablePath: process.env.MAY_CHROMIUM_PATH } : {}) }); t.after(() => browser.close());
  const module = await readFile(new URL("../dist/apps-browser.js", import.meta.url), "utf8");
  const host = createServer((req, res) => { res.setHeader("content-type", req.url === "/module.js" ? "text/javascript" : "text/html"); res.end(req.url === "/module.js" ? module : '<!doctype html><div id="app"></div>'); });
  host.listen(0, "127.0.0.1"); await once(host, "listening");
  t.after(() => { host.close(); host.closeAllConnections(); });
  const origin = `http://127.0.0.1:${host.address().port}`;
  const sandboxDocument = mcpAppSandboxResponse(origin);
  const sandbox = createServer((req, res) => { res.writeHead(200, sandboxDocument.headers); res.end(sandboxDocument.body); });
  sandbox.listen(0, "127.0.0.1"); await once(sandbox, "listening");
  t.after(() => { sandbox.close(); sandbox.closeAllConnections(); });
  const sandboxUrl = `http://127.0.0.1:${sandbox.address().port}`;
  const page = await browser.newPage(); await page.goto(origin);
  await page.evaluate(async ({ sandboxUrl }) => {
    const { mountMcpApp } = await import("/module.js");
    window.messages = []; window.closedApp = false;
    const html = `<!doctype html><script>
      let isolated=false;try{parent.document.body}catch{isolated=true}
      fetch('https://example.com/blocked').then(()=>{},()=>parent.postMessage({jsonrpc:'2.0',method:'test',params:{isolated,blocked:true}},'*'));
    <\/script>`;
    window.app = mountMcpApp(document.getElementById("app"), sandboxUrl, { resource: { html }, async receive(message) { window.messages.push(message); }, close() { window.closedApp = true; } });
  }, { sandboxUrl });
  await page.waitForFunction(() => window.messages.some((m) => m.method === "test"));
  assert.deepEqual(await page.evaluate(() => window.messages.find((m) => m.method === "test").params), { isolated: true, blocked: true });
  await page.evaluate(() => window.postMessage({ jsonrpc: "2.0", method: "tools/call" }, location.origin));
  assert.equal(await page.evaluate(() => window.messages.length), 1, "wrong message source is ignored");
  await page.evaluate(() => window.app.close());
  assert.equal(await page.locator("iframe").count(), 0); assert.equal(await page.evaluate(() => window.closedApp), true);
});
