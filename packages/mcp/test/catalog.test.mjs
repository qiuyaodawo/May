import assert from "node:assert/strict";
import test from "node:test";
import { openMcpClientPool } from "../dist/index.js";
import { startCatalogFixture } from "./fixtures/catalog-server.mjs";

const context = (signal = new AbortController().signal) => ({ signal, runId: "run", step: 1,
  toolCallId: "call", idempotencyKey: "run:call", report() {} });
const until = async (condition) => {
  const deadline = Date.now() + 2500;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

test("catalogs paginate, refresh and reconnect without replacing running tool snapshots or replaying calls", { timeout: 12_000 }, async (t) => {
  const fixture = await startCatalogFixture(t);
  fixture.state.available = false;
  const optional = await openMcpClientPool({ servers: [{ id: "optional", required: false,
    transport: "streamable-http", url: `${fixture.url}/resources`, requestTimeoutMs: 500 }] });
  assert.equal(optional.status()[0].state, "failed");
  fixture.state.available = true;
  await optional.reconnect("optional");
  assert.equal(optional.status()[0].state, "connected");
  await optional.close();
  const pool = await openMcpClientPool({ servers: ["modern", "legacy", "resources"].map((id) => ({
    id, transport: "streamable-http", url: `${fixture.url}/${id}`, requestTimeoutMs: 1000,
  })) });
  t.after(() => pool.close());
  const events = [];
  const eventTask = (async () => { for await (const event of pool.events) events.push(event); })();
  assert.equal(pool.catalog().length, 3);
  assert.deepEqual(pool.status().map((s) => s.catalogSubscription), ["active", "legacy", "active"]);
  for (const catalog of pool.catalog()) {
    assert.deepEqual(catalog.resources.map((r) => r.uri), ["test:///first", "test:///second"]);
    assert.equal(catalog.resourceTemplates[0].uriTemplate, "test:///{name}");
    assert.equal(catalog.prompts[0].arguments[0].required, true);
    assert.ok(Object.isFrozen(catalog.prompts[0].arguments));
  }
  assert.equal(pool.catalog()[2].tools.length, 0);
  assert.equal(fixture.requests.some((r) => r.path === "/resources" && r.message?.method === "tools/list"), false);
  const original = pool.tools[0];
  const initialCatalog = pool.catalog()[0];
  fixture.state.version = 2;
  await pool.refresh("modern");
  assert.equal(pool.catalog()[0].revision, 2, "manual refresh bypasses a long cache TTL");
  assert.equal(initialCatalog.tools[0].annotations.readOnlyHint, true);
  assert.notEqual(original.permissionVersion, pool.tools[0].permissionVersion);
  const calls = () => fixture.requests.filter((r) => r.message?.method === "tools/call").length;
  await assert.rejects(original.execute({}, context()), (e) => e.code === "MCP_STALE_TOOL");
  assert.equal(calls(), 0, "stale call never goes on the wire");
  assert.equal((await pool.tools[0].execute({}, context())).content[0].text, "version:2");
  const unchanged = pool.tools[0];
  await pool.refresh("modern");
  assert.equal(pool.catalog()[0].revision, 2);
  assert.equal(pool.tools[0].permissionVersion, unchanged.permissionVersion);
  // Alter annotation back to force a definition revision on both eras.
  fixture.state.version = 1;
  fixture.notify();
  await until(() => pool.catalog()[0].revision === 3 && !pool.status().some((s) => s.catalogStale));
  assert.ok(events.some((e) => e.type === "mcp.server.catalog-updated"));
  const abort = new AbortController();
  const pending = pool.tools[0].execute({ hold: true }, context(abort.signal));
  await until(() => calls() === 2);
  await assert.rejects(pool.reconnect("modern"), (e) => e.code === "MCP_CATALOG_ERROR");
  abort.abort(); await assert.rejects(pending);
  const beforeReconnect = pool.tools[0];
  await pool.reconnect("modern");
  assert.notEqual(pool.tools[0].permissionVersion, beforeReconnect.permissionVersion);
  await assert.rejects(beforeReconnect.execute({}, context()));
  assert.equal(calls(), 2, "reconnect never replays an operation");
  fixture.state.repeatCursor = true;
  const priorRevision = pool.catalog()[0].revision;
  await assert.rejects(pool.refresh("modern"), (e) => e.code === "MCP_CATALOG_ERROR");
  assert.equal(pool.catalog()[0].revision, priorRevision, "partial catalog is never published");
  assert.equal(pool.status()[0].catalogStale, true);
  fixture.state.repeatCursor = false;
  await pool.refresh("modern");
  fixture.state.holdList = true;
  const beforeList = fixture.requests.length;
  const refresh = assert.rejects(pool.refresh("modern"));
  await until(() => fixture.requests.length > beforeList);
  await pool.close(); await refresh;
  await eventTask;
  await assert.rejects(pool.reconnect("modern"));
});
