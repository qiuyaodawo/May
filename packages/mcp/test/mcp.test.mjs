import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  namespaceMcpToolName,
  openMcpClientPool,
} from "../dist/index.js";

const fixture = fileURLToPath(
  new URL("./fixtures/stdio-server.mjs", import.meta.url),
);

test("discovers and calls namespaced stdio MCP tools", async (t) => {
  const spans = [];
  const tracer = recordingTracer(spans);
  const pool = await openMcpClientPool({
    servers: [{
      id: "test",
      command: process.execPath,
      args: [fixture],
      requestTimeoutMs: 5_000,
    }],
    tracer,
  });
  t.after(() => pool.close());

  assert.deepEqual(
    pool.tools.map((tool) => tool.name),
    ["mcp__test__echo_value", "mcp__test__reported-error"],
  );
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
  assert.deepEqual(
    spans.map((span) => [span.name, span.status]),
    [
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
          });
        },
      };
      return span;
    },
  };
}
