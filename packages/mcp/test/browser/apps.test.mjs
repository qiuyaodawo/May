import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { mcpAppSandboxResponse } from "../../dist/index.js";

test("Apps double iframe enforces browser origin/CSP isolation and tears down the channel", { timeout: 20_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const module = await readFile(new URL("../../dist/apps-browser.js", import.meta.url), "utf8");
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
