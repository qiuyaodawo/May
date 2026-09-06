import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  namespaceMcpToolName,
  openMcpClientPool,
  validateMcpServerOptions,
} from "../dist/index.js";
import { startHttpFixture } from "./fixtures/http-server.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/stdio-server.mjs", import.meta.url),
);

test("discovers and calls namespaced stdio MCP tools", async (t) => {
  const spans = [];
  const tracer = recordingTracer(spans);
  const pool = await openMcpClientPool({
    servers: [
      {
        id: "optional",
        command: process.execPath,
        args: [fixture, "--fail"],
        requestTimeoutMs: 5_000,
        stderrMaxBytes: 64,
        required: false,
      },
      {
        id: "test",
        command: process.execPath,
        args: [fixture],
        requestTimeoutMs: 5_000,
      },
    ],
    tracer,
  });
  t.after(() => pool.close());
  const events = collectEvents(pool.events);

  assert.deepEqual(
    pool.tools.map((tool) => tool.name),
    ["mcp__test__echo_value", "mcp__test__reported-error"],
  );
  assert.deepEqual(
    pool.status().map((status) => [
      status.serverId,
      status.required,
      status.state,
      status.toolNames.length,
    ]),
    [
      ["optional", false, "failed", 0],
      ["test", true, "connected", 2],
    ],
  );
  assert.match(pool.status()[0].diagnostic.stderr, /STARTUP_DIAGNOSTIC/u);
  assert.doesNotMatch(pool.status()[0].diagnostic.stderr, /\u001b/u);
  assert.ok(Buffer.byteLength(pool.status()[0].diagnostic.stderr) <= 64);
  const progress = [];
  const output = await pool.tools[0].execute(
    pool.tools[0].parse({ value: "hello" }),
    executionContext(progress),
  );
  assert.deepEqual(output, {
    content: [{ type: "text", text: "echo:hello" }],
    structuredContent: { echoed: "hello" },
  });
  assert.equal(progress[0].message, "remote work complete");

  await assert.rejects(
    pool.tools[1].execute({}, executionContext([])),
    (error) => error.code === "MCP_TOOL_ERROR" &&
      /remote failure/u.test(error.message),
  );
  const cancellation = new AbortController();
  const pending = pool.tools[0].execute(
    { value: "never" },
    executionContext([], cancellation.signal),
  );
  setTimeout(() => cancellation.abort("stop"), 10);
  await assert.rejects(pending);
  await pool.close();
  assert.equal(pool.status()[1].state, "disconnected");
  assert.deepEqual(
    (await events).map((event) => event.type),
    [
      "mcp.server.failed",
      "mcp.server.connected",
      "mcp.server.disconnected",
    ],
  );
  assert.deepEqual(
    spans.map((span) => [span.name, span.status]),
    [
      ["may.mcp.connect", "error"],
      ["may.mcp.connect", "ok"],
      ["may.mcp.tools.list", "ok"],
      ["may.mcp.tool.call", "ok"],
      ["may.mcp.tool.call", "error"],
      ["may.mcp.tool.call", "cancelled"],
      ["may.mcp.disconnect", "ok"],
    ],
  );
});

test("creates bounded provider-safe names and rejects duplicate servers", async () => {
  const name = namespaceMcpToolName("server", "x".repeat(100));
  assert.equal(name.length, 64);
  assert.match(name, /^[A-Za-z0-9_-]+$/u);

  await assert.rejects(
    openMcpClientPool({
      servers: [
        { id: "same", command: process.execPath },
        { id: "same", command: process.execPath },
      ],
    }),
    (error) => error.code === "MCP_CONFIGURATION_ERROR",
  );

  await assert.rejects(
    openMcpClientPool({
      servers: [{
        id: "required",
        command: process.execPath,
        args: [fixture, "--fail"],
        requestTimeoutMs: 5_000,
      }],
    }),
    (error) => error.code === "MCP_CONNECTION_FAILED" &&
      /STARTUP_DIAGNOSTIC/u.test(error.stderr),
  );
});

test("mixes stdio and HTTP endpoints with modern discovery and legacy fallback", async (t) => {
  const http = await startHttpFixture(t);
  const spans = [];
  const pool = await openMcpClientPool({
    servers: [
      { id: "local", command: process.execPath, args: [fixture] },
      ...["legacy", "modern"].map((id) => ({
        id, transport: "streamable-http", url: `${http.url}/${id}`,
        headers: { Authorization: "Bearer test-secret" }, requestTimeoutMs: 2_000,
      })),
    ],
    tracer: recordingTracer(spans),
  });
  t.after(() => pool.close());
  const events = collectEvents(pool.events);
  assert.deepEqual(pool.status().map((s) => [s.transport, s.protocolVersion]), [
    ["stdio", "2025-11-25"], ["streamable-http", "2025-11-25"], ["streamable-http", "2026-07-28"],
  ]);
  for (const id of ["legacy", "modern"]) {
    const tool = pool.tools.find((entry) => entry.name === `mcp__${id}__echo`);
    const progress = [];
    assert.deepEqual(await tool.execute({ value: "hello" }, executionContext(progress)), {
      content: [{ type: "text", text: "hello" }], structuredContent: { echoed: "hello" },
    });
    assert.equal(progress[0].message, "http progress");
    await assert.rejects(tool.execute({ value: "tool-error" }, executionContext([])),
      (error) => error.code === "MCP_TOOL_ERROR" && /remote tool failed/u.test(error.message));
    await assert.rejects(tool.execute({ value: "http-error" }, executionContext([])),
      (error) => error.code === "MCP_TOOL_CALL_FAILED" && /503/u.test(error.message));
    const cancellation = new AbortController();
    const pending = tool.execute({ value: "never" }, executionContext([], cancellation.signal));
    setTimeout(() => cancellation.abort("stop"), 40);
    await assert.rejects(pending);
  }
  await pool.close();
  await pool.close();
  assert.ok(pool.status().every((status) => status.state === "disconnected"));
  assert.equal((await events).filter((e) => e.transport === "streamable-http").length, 4);
  assert.ok(http.requests.every((r) => r.headers.authorization === "Bearer test-secret"));
  assert.equal(http.requests.filter((r) => r.path === "/modern" && r.message?.method === "initialize").length, 0);
  assert.equal(http.requests.filter((r) => r.method === "DELETE").length, 1);
  for (const path of ["/legacy", "/modern"]) {
    assert.equal(http.requests.filter((r) => r.path === path && r.message?.params?.arguments?.value === "http-error").length, 1);
  }
  const modernCall = http.requests.find((r) => r.path === "/modern" && r.message?.method === "tools/call");
  assert.equal(modernCall.message.params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.doesNotMatch(JSON.stringify(spans), /test-secret|sensitive-response-body|127\.0\.0\.1/u);
});

test("validates HTTP boundaries and keeps denied endpoints isolated without following redirects", async (t) => {
  const http = await startHttpFixture(t);
  const base = { id: "remote", transport: "streamable-http", url: `${http.url}/modern` };
  for (const extra of [
    { url: "http://example.com/mcp" }, { url: "https://user:password@example.com" },
    { url: "https://example.com/#fragment" }, { url: "file:///tmp/mcp" },
    { command: "node" }, { headers: { "Mcp-Session-Id": "spoof" } },
    { headers: { Authorization: "one", authorization: "two" } },
    { headers: { Authorization: "line\nbreak" } }, { protocolMode: "unknown" },
  ]) {
    assert.throws(() => validateMcpServerOptions({ ...base, ...extra }),
      (error) => error.code === "MCP_CONFIGURATION_ERROR");
  }
  const spans = [];
  const pool = await openMcpClientPool({
    servers: ["redirect", "unauthorized", "unavailable", "modern"].map((id) => ({
      ...base, id, url: `${http.url}/${id}`, required: id === "modern", requestTimeoutMs: 1_000,
    })),
    tracer: recordingTracer(spans),
  });
  t.after(() => pool.close());
  assert.deepEqual(pool.status().map((s) => s.state), ["failed", "failed", "failed", "connected"]);
  assert.match(pool.status()[1].diagnostic.message, /401/u);
  assert.match(pool.status()[2].diagnostic.message, /503/u);
  assert.equal(http.requests.some((r) => r.path === "/leaked"), false);
  assert.doesNotMatch(JSON.stringify([pool.status(), spans]), /sensitive-response-body|test-secret|127\.0\.0\.1/u);
  await assert.rejects(openMcpClientPool({
    servers: [{ ...base, url: `${http.url}/unavailable` }],
  }), (error) => error.code === "MCP_CONNECTION_FAILED" && /503/u.test(error.message));

  const cancelled = new AbortController();
  const reason = new Error("stop discovery");
  const pending = openMcpClientPool({
    servers: [{ ...base, url: `${http.url}/silent`, requestTimeoutMs: 10_000 }],
    signal: cancelled.signal,
  });
  setTimeout(() => cancelled.abort(reason), 30);
  await assert.rejects(pending, (error) => error === reason);
  const bounded = await openMcpClientPool({
    servers: [{ ...base, url: `${http.url}/silent`, requestTimeoutMs: 10_000, maxTotalTimeoutMs: 30, required: false }],
  });
  assert.equal(bounded.status()[0].state, "failed");
  await bounded.close();
});

function executionContext(progress, signal = new AbortController().signal) {
  return {
    runId: "run-1",
    step: 1,
    toolCallId: "call-1",
    idempotencyKey: "run-1:1:call-1",
    signal,
    report(update) {
      progress.push(update);
    },
  };
}

function recordingTracer(completed) {
  let sequence = 0;
  return {
    startSpan(name, options = {}) {
      const span = {
        context: { traceId: "trace", spanId: `span-${++sequence}` },
        setAttributes() {},
        addEvent() {},
        end(result = {}) {
          completed.push({
            name,
            status: result.status ?? "ok",
            attributes: { ...options.attributes, ...result.attributes },
            error: result.error,
          });
        },
      };
      return span;
    },
  };
}

async function collectEvents(events) {
  const collected = [];
  for await (const event of events) collected.push(event);
  return collected;
}
