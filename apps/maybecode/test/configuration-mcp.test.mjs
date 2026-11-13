import assert from "node:assert/strict";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assistantMessage, temporaryDirectory } from "./fixtures/application.mjs";

import { openConfiguredMaybeCode, runMaybeCode } from "../dist/index.js";
import { formatMaybeCodeMcpStatus } from "../dist/slash-commands.js";
import { executeMaybeCodeSlashCommand } from "../dist/slash-command-execution.js";
import { createCodingPermissionPolicy } from "../dist/policy.js";
import { parseMaybeCodeArgs } from "../dist/args.js";
import { resolveMaybeCodeMcp } from "../dist/configured-resolvers.js";
import { runMaybeCodeMcpCommand } from "../dist/mcp-auth.js";

test("adds configured MCP tools and owns the client pool lifecycle", async (t) => {
  const directory = await temporaryDirectory(t);
  let openedWith;
  let mockPool;
  const refreshed = [];
  let request;
  let closed = false;
  let releaseEvents;
  const app = await openConfiguredMaybeCode(
    { git: false, workspace: directory, dataDirectory: join(directory, "data"), autoResume: false },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: { local: { adapter: "test", apiKey: "test" } },
          models: { chat: { provider: "local", model: "test" } },
          defaultModel: "chat",
          apps: {
            maybecode: {
              requestRecording: "off",
              retry: false,
              mcpServers: {
                local: { command: "test-server", args: ["--stdio"] },
              },
            },
          },
        };
      },
      createModel() {
        return {
          async *stream(value) {
            request = value;
            yield {
              type: "response.completed",
              message: assistantMessage("ok"),
            };
          },
        };
      },
      async openMcp(options) {
        openedWith = options;
        const closedEvent = new Promise((resolve) => {
          releaseEvents = resolve;
        });
        return (mockPool = {
          async refresh(id) {
            refreshed.push(["refresh", id]);
          },
          async reconnect(id) {
            refreshed.push(["reconnect", id]);
          },
          events: {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "mcp.server.connected",
                seq: 1,
                timestamp: Date.now(),
                serverId: "local",
                transport: "stdio",
                required: true,
                toolNames: ["mcp__local__lookup"],
              };
              await closedEvent;
              yield {
                type: "mcp.server.disconnected",
                seq: 2,
                timestamp: Date.now(),
                serverId: "local",
                transport: "stdio",
                required: true,
              };
            },
          },
          tools: [
            {
              name: "mcp__local__lookup",
              description: "lookup",
              inputSchema: { type: "object" },
              async execute() {
                return { content: [{ type: "text", text: "found" }] };
              },
            },
          ],
          status() {
            return [
              {
                serverId: "local",
                transport: "stdio",
                required: true,
                state: "connected",
                toolNames: ["mcp__local__lookup"],
              },
            ];
          },
          async close() {
            closed = true;
            releaseEvents();
          },
        });
      },
    },
  );

  assert.deepEqual(openedWith.servers, [
    {
      id: "local",
      command: "test-server",
      args: ["--stdio"],
      cwd: await realpath(directory),
    },
  ]);
  assert.equal((await app.getMcpStatus())[0].state, "connected");
  assert.equal((await executeMaybeCodeSlashCommand("/mcp", app)).type, "mcp.status");
  const observedEvents = [];
  const eventTask = (async () => {
    for await (const event of app.events) observedEvents.push(event);
  })();
  await (
    await app.submit({ input: "hello" })
  ).result;
  assert.ok(request.tools.some((tool) => tool.name === "read"));
  assert.ok(request.tools.some((tool) => tool.name === "mcp__local__lookup"));
  mockPool.tools = [{ ...mockPool.tools[0], name: "mcp__local__updated" }];
  await (
    await app.submit({ input: "next run" })
  ).result;
  assert.ok(request.tools.some((tool) => tool.name === "mcp__local__updated"));
  assert.ok(!request.tools.some((tool) => tool.name === "mcp__local__lookup"));
  await executeMaybeCodeSlashCommand("/mcp refresh local", app);
  await executeMaybeCodeSlashCommand("/mcp reconnect local", app);
  assert.deepEqual(refreshed, [
    ["refresh", "local"],
    ["reconnect", "local"],
  ]);
  await app.close();
  await eventTask;
  assert.equal(closed, true);
  assert.deepEqual(
    observedEvents.filter((event) => event.type.startsWith("mcp.server.")).map((event) => event.type),
    ["mcp.server.connected", "mcp.server.disconnected"],
  );
});

test("resolves workspace-relative MCP servers and environment references", () => {
  const workspace = join(process.cwd(), "workspace");
  const base = { path: "config.json", providers: {}, models: {} };
  assert.equal(resolveMaybeCodeMcp(base, workspace), false);
  assert.deepEqual(
    resolveMaybeCodeMcp(
      {
        ...base,
        apps: {
          maybecode: {
            mcpServers: {
              files: {
                command: "node",
                args: ["server.mjs", "--root", "."],
                cwd: "tools",
                env: { TOKEN: "Bearer ${MCP_TOKEN}" },
                required: false,
                requestTimeoutMs: 1_000,
                stderrMaxBytes: 2_048,
              },
              disabled: { enabled: false },
            },
          },
        },
      },
      workspace,
      { MCP_TOKEN: "secret" },
    ),
    {
      servers: [
        {
          id: "files",
          command: "node",
          required: false,
          args: ["server.mjs", "--root", "."],
          cwd: join(workspace, "tools"),
          env: { TOKEN: "Bearer secret" },
          requestTimeoutMs: 1_000,
          stderrMaxBytes: 2_048,
        },
      ],
    },
  );
  assert.throws(
    () =>
      resolveMaybeCodeMcp(
        {
          ...base,
          apps: {
            maybecode: {
              mcpServers: {
                files: { command: "node", env: { TOKEN: "${MISSING}" } },
              },
            },
          },
        },
        workspace,
        {},
      ),
    /missing environment variable MISSING/u,
  );
});

test("resolves HTTP MCP headers, validates transport options, and formats protocol status", () => {
  const workspace = process.cwd();
  const base = { path: "config.json", providers: {}, models: {} };
  const config = (remote) => ({
    ...base,
    apps: { maybecode: { mcpServers: { remote } } },
  });
  const endpoint = {
    transport: "streamable-http",
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${MCP_TOKEN}" },
    protocolMode: "auto",
    required: false,
    requestTimeoutMs: 1_000,
  };
  assert.deepEqual(resolveMaybeCodeMcp(config(endpoint), workspace, { MCP_TOKEN: "secret" }), {
    servers: [{ ...endpoint, id: "remote", headers: { Authorization: "Bearer secret" } }],
  });
  assert.throws(() => resolveMaybeCodeMcp(config(endpoint), workspace, {}), /missing environment variable MCP_TOKEN/u);
  for (const change of [
    { cwd: "." },
    { command: "node" },
    { stderrMaxBytes: 1_024 },
    { url: "http://example.com" },
    { transport: "sse" },
    { protocolMode: "pin" },
    { headers: { Host: "spoof" } },
  ]) {
    assert.throws(() => resolveMaybeCodeMcp(config({ ...endpoint, ...change }), workspace, { MCP_TOKEN: "secret" }));
  }
  assert.throws(
    () => resolveMaybeCodeMcp(config({ command: "node", headers: {} }), workspace),
    /mcpServers\.remote\.headers is not supported/u,
  );
  assert.match(
    formatMaybeCodeMcpStatus([
      {
        serverId: "remote",
        transport: "streamable-http",
        required: false,
        state: "connected",
        protocolVersion: "2026-07-28",
        toolNames: ["mcp__remote__lookup"],
      },
    ]),
    /optional, streamable-http\)\n  protocol: 2026-07-28/u,
  );
});

test("MCP login commands run before model startup and accept OAuth configuration", async () => {
  const command = parseMaybeCodeArgs(["mcp", "login", "remote", "--config", "auth.json", "--scope", "write"]);
  assert.deepEqual(command, {
    type: "mcp",
    action: "login",
    serverId: "remote",
    configPath: "auth.json",
    scopes: ["write"],
  });
  assert.throws(() => parseMaybeCodeArgs(["mcp", "logout", "remote", "--scope", "write"]));
  const configured = {
    path: "auth.json",
    providers: {},
    models: {},
    apps: {
      maybecode: {
        mcpServers: {
          remote: {
            transport: "streamable-http",
            url: "https://mcp.example.com/mcp",
            auth: { type: "oauth", scopes: ["read"], authorizationOrigins: ["https://accounts.example.com"] },
          },
        },
      },
    },
  };
  const output = [];
  let loggedIn;
  const deps = {
    write: (text) => output.push(text),
    loadConfig: async () => configured,
    oauth: {
      async login(server) {
        loggedIn = server;
      },
    },
  };
  await runMaybeCodeMcpCommand(command, deps);
  assert.deepEqual(loggedIn.auth.scopes, ["read", "write"]);
  assert.match(output.join(""), /login complete/u);
  const code = await runMaybeCode(["mcp", "status", "remote"], {
    terminal: { write: (text) => output.push(text), close() {} },
    open: () => {
      throw new Error("Agent must not start");
    },
    mcpAuth: async (value) => {
      assert.equal(value.action, "status");
    },
  });
  assert.equal(code, 0);
  configured.apps.maybecode.mcpServers.remote.auth.clientId = "public-client";
  assert.throws(() => resolveMaybeCodeMcp(configured, process.cwd()), /auth must have property expectedIssuer/u);
});

test("scopes MCP approval grants to one namespaced tool", async () => {
  const policy = createCodingPermissionPolicy();
  const decision = await policy({
    tool: {
      name: "mcp__workspace__lookup",
      description: "lookup",
      inputSchema: { type: "object" },
    },
    input: { query: "value" },
    context: {
      runId: "run",
      step: 1,
      toolCallId: "call",
      idempotencyKey: "run:1:call",
      signal: new AbortController().signal,
      report() {},
    },
  });
  assert.deepEqual(decision, {
    decision: "ask",
    grantKey: "mcp:mcp__workspace__lookup",
  });
});
