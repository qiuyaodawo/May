import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PluginHost } from "@may/plugin";
import { createMcpHostPlugin, mcpHostService } from "../dist/index.js";

test("MCP plugin connects an actual filesystem server and closes its owned transport", async () => {
  const workspace = fileURLToPath(new URL("../../../..", import.meta.url));
  const host = await PluginHost.create({ plugins: [createMcpHostPlugin({
    servers: [{ id: "filesystem", command: process.execPath, args: [fileURLToPath(new URL("read-server.mjs", import.meta.url)), workspace], protocolMode: "auto" }],
  })] });
  try {
    const pool = host.get(mcpHostService);
    const tool = pool.tools.find(value => value.name === "mcp__filesystem__read");
    assert.ok(tool);
    const output = await tool.execute(tool.parse({ path: "package.json" }), {
      runId: "mcp-file-read", step: 1, toolCallId: "read-package", idempotencyKey: "mcp-read-package",
      scope: { workspaceId: workspace, sessionId: "mcp-session" }, signal: new AbortController().signal, report() {},
    });
    assert.equal(output.content[0].text, await readFile(new URL("../../../../package.json", import.meta.url), "utf8"));
    await host.close();
    await assert.rejects(pool.refresh(), /closed/u);
  } finally { await host.close(); }
});
