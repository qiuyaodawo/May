import assert from "node:assert/strict";
import test from "node:test";
import { liveModelProfile } from "../fixtures/live-model.mjs";
import { workspaceFor } from "../fixtures/plugin-workspace.mjs";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { defaultSubagentConfiguration } from "@sortedyuan/coordination/delegation";
import { createMcpPlugin } from "@sortedyuan/mcp/plugin";
import { openMcpClientPool } from "@sortedyuan/mcp";
import { openConfiguredMaybeCode } from "../../dist/index.js";

test(
  "configured MCP and tracing plugins serve actual files across Session changes and flush on close",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-mcp-live-");
    const application = await openConfiguredMaybeCode({
      git: false,
      workspace,
      model: liveModelProfile(),
      dataDirectory: join(workspace, "data"),
      skills: false,
      subagents: false,
      goals: false,
      instructions: "Use the exact tool name requested and quote evidence from the tool output.",
      observability: { scheduledDelayMs: 60000 },
      mcp: {
        servers: [
          {
            id: "filesystem",
            command: process.execPath,
            args: [
              fileURLToPath(new URL("../../../../packages/mcp/test/plugin/read-server.mjs", import.meta.url)),
              workspace,
            ],
            protocolMode: "auto",
          },
        ],
      },
    });
    t.after(() => application.close());
    const events = [];
    const observing = (async () => {
      for await (const event of application.events) {
        events.push(event);
        if (event.type === "permission.event" && event.event.type === "approval.requested")
          await application.resolveApproval(event.event.request.id, "allow");
      }
    })();
    const result = await (
      await application.submit({
        input:
          "Use mcp__filesystem__read to read README.md, then quote only its first Markdown heading. Do not use the local read tool or shell.",
      })
    ).result;
    assert.match(JSON.stringify(result.message), /May/u);
    const firstSession = application.sessionId;
    await application.newSession();
    assert.notEqual(application.sessionId, firstSession);
    assert.equal((await application.getMcpStatus())[0].state, "connected");
    await application.close();
    await observing;
    assert.ok(
      events.some(
        (event) =>
          event.type === "run.event" &&
          event.event.type === "tool.completed" &&
          event.event.call.name === "mcp__filesystem__read",
      ),
    );
    const traces = join(workspace, "data", "traces");
    const files = await readdir(traces);
    const spans = (await Promise.all(files.map((file) => readFile(join(traces, file), "utf8"))))
      .join("\n")
      .trim()
      .split(/\n+/u)
      .map((value) => JSON.parse(value));
    assert.ok(spans.some((span) => span.name === "may.model.call"));
    assert.ok(spans.some((span) => span.name.startsWith("may.mcp")));
  },
);

test(
  "selected MCP services expose actual catalog, commands and events and own each Session connection",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-selected-mcp-live-");
    const pools = [];
    const plugin = createMcpPlugin({
      servers: [
        {
          id: "filesystem",
          command: process.execPath,
          args: [
            fileURLToPath(new URL("../../../../packages/mcp/test/plugin/read-server.mjs", import.meta.url)),
            workspace,
          ],
          protocolMode: "auto",
        },
      ],
      enableInteractions: true,
      async open(options) {
        const pool = await openMcpClientPool(options);
        pools.push(pool);
        return pool;
      },
    });
    const application = await openConfiguredMaybeCode({
      git: false,
      workspace,
      model: liveModelProfile(),
      dataDirectory: join(workspace, "data"),
      plugins: [plugin],
      skills: false,
      goals: false,
      subagents: false,
      mcp: { servers: [{ id: "unused", command: "unused-mcp-command" }] },
      instructions: "Use the exact requested tool and quote its actual output. Do not use other tools.",
    });
    t.after(() => application.close());
    const events = [];
    const observing = (async () => {
      for await (const event of application.events) {
        events.push(event);
        if (event.type === "permission.event" && event.event.type === "approval.requested")
          await application.resolveApproval(event.event.request.id, "allow");
      }
    })();
    assert.equal(pools.length, 1);
    assert.deepEqual(
      (await application.getMcpStatus()).map((server) => server.serverId),
      ["filesystem"],
    );
    assert.equal((await application.getMcpStatus())[0].state, "connected");
    assert.deepEqual(application.getMcpCatalog(), pools[0].catalog());
    assert.ok(application.getMcpCatalog()[0].tools.some((tool) => tool.name === "read"));
    const revision = application.getMcpCatalog()[0].revision;
    await application.refreshMcp("filesystem");
    assert.equal(application.getMcpCatalog()[0].revision, revision);
    await application.reconnectMcp("filesystem");
    const result = await (
      await application.submit({
        input: "Use mcp__filesystem__read to read README.md, then quote only its first Markdown heading.",
      })
    ).result;
    assert.match(JSON.stringify(result.message), /May/u);
    const previous = application.sessionId;
    await application.newSession();
    assert.notEqual(application.sessionId, previous);
    assert.equal(pools.length, 2);
    assert.equal(pools[0].status()[0].state, "disconnected");
    assert.equal((await application.getMcpStatus())[0].state, "connected");
    assert.deepEqual(application.getMcpCatalog(), pools[1].catalog());
    await application.refreshMcp("filesystem");
    await application.resumeSession(previous);
    assert.equal(application.sessionId, previous);
    assert.equal(pools.length, 3);
    assert.equal(pools[1].status()[0].state, "disconnected");
    assert.deepEqual(application.getMcpCatalog(), pools[2].catalog());
    await application.refreshMcp("filesystem");
    await Promise.all([application.close(), application.close()]);
    await observing;
    assert.ok(pools.every((pool) => pool.status()[0].state === "disconnected"));
    assert.ok(
      events.filter((event) => event.type === "mcp.server.connected" && event.serverId === "filesystem").length >= 3,
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "run.event" &&
          event.event.type === "tool.completed" &&
          event.event.call.name === "mcp__filesystem__read",
      ),
    );
  },
);

test(
  "delegation children use the selected MCP service with their own Session and actual filesystem permission",
  { timeout: 120000 },
  async (t) => {
    const workspace = await workspaceFor(t, "plugin-child-mcp-live-");
    const base = defaultSubagentConfiguration();
    const application = await openConfiguredMaybeCode({
      git: false,
      workspace,
      model: liveModelProfile(),
      dataDirectory: join(workspace, "data"),
      plugins: [
        createMcpPlugin({
          servers: [
            {
              id: "filesystem",
              command: process.execPath,
              args: [
                fileURLToPath(new URL("../../../../packages/mcp/test/plugin/read-server.mjs", import.meta.url)),
                workspace,
              ],
              protocolMode: "auto",
            },
          ],
        }),
      ],
      skills: false,
      goals: false,
      maxSteps: 8,
      subagents: {
        configuration: {
          ...base,
          roles: [{ name: "worker", tools: ["read"], delegateTo: [] }],
          limits: { ...base.limits, maxTasks: 2 },
        },
      },
      instructions:
        "Use delegate_tasks when delegation is requested. Child tasks must use the exact MCP tool requested and quote evidence from the actual tool output.",
    });
    t.after(() => application.close());
    const approvals = [];
    const observing = (async () => {
      for await (const event of application.events) {
        const permission = event.type === "delegation.event" ? event.event : event;
        if (permission.type === "permission.event" && permission.event.type === "approval.requested") {
          approvals.push(event);
          await application.resolveApproval(permission.event.request.id, "allow");
        }
      }
    })();
    const result = await (
      await application.submit({
        input:
          "Delegate exactly one worker task with id mcp-read-doc. Provide this standalone brief: use mcp__filesystem__read to read README.md and quote its first Markdown heading from the actual output. Do not use local read or shell, and do not modify any files. After the child completes, reply with its heading. Do not read the file yourself.",
      })
    ).result;
    assert.match(JSON.stringify(result.message), /May/u);
    const state = application.application.getDelegationState();
    const child = state.tasks.find((task) => task.id === "mcp-read-doc");
    assert.ok(child);
    assert.equal(child.status, "completed");
    assert.notEqual(child.sessionId, application.sessionId);
    const records = await application.application.delegationToolRecords(child.id);
    assert.ok(
      records.records.some((record) => record.name === "mcp__filesystem__read" && record.status === "completed"),
    );
    assert.ok(approvals.some((event) => event.type === "delegation.event" && event.sessionId === child.sessionId));
    assert.ok(state.budget.modelCalls >= 3);
    assert.equal(
      (await application.history()).filter(
        (event) => event.type === "tool.completed" && event.call.name === "mcp__filesystem__read",
      ).length,
      0,
    );
    await application.close();
    await observing;
  },
);
