import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext } from "@may/core";

import { createMaybeCodeSlashCommandSuggester, createCodingPermissionPolicy, executeMaybeCodeSlashCommand, formatMaybeCodeMcpStatus, openConfiguredMaybeCode, parseMaybeCodeArgs, resolveMaybeCodeMcp, runMaybeCode, runMaybeCodeMcpCommand, resolveMaybeCodeObservability, resolveMaybeCodeRetry } from "../dist/index.js";

test("parses MaybeCode startup options", () => {
  assert.deepEqual(
    parseMaybeCodeArgs([
      "--config",
      "custom.json",
      "--model",
      "reasoner",
      "--resume",
      "abc",
      ".",
    ]),
    {
      type: "start",
      workspace: ".",
      configPath: "custom.json",
      model: "reasoner",
      sessionId: "abc",
      autoResume: false,
      ui: "retained",
    },
  );
  assert.equal(parseMaybeCodeArgs(["--ui", "retained"]).ui, "retained");
  assert.equal(parseMaybeCodeArgs(["--ui", "classic"]).ui, "classic");
  assert.equal(parseMaybeCodeArgs([]).autoResume, false);
  assert.equal(parseMaybeCodeArgs(["--continue"]).autoResume, true);
  assert.throws(
    () => parseMaybeCodeArgs(["--continue", "--resume", "abc"]),
    /cannot be used together/,
  );
  assert.throws(
    () => parseMaybeCodeArgs(["--config", "--model", "chat"]),
    /--config requires a value/,
  );
});

test("opens configured MaybeCode with injected model creation", async (t) => {
  const directory = await temporaryDirectory(t);
  const configDirectory = join(directory, "config");
  const instructionsDirectory = join(configDirectory, "instructions", "maybecode");
  await mkdir(instructionsDirectory, { recursive: true });
  await writeFile(join(instructionsDirectory, "system.md"), "custom system");
  await writeFile(join(directory, "AGENTS.md"), "project rules");
  let selected;
  let request;
  let contextOptions;
  const app = await openConfiguredMaybeCode(
    {
      skills: false,
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
      contextFactory: {
        create(options) {
          contextOptions = options;
          const context = new InMemoryContext({
            instructions: options.instructions,
            messages: [...(options.messages ?? [])],
            metadata: { ...options.metadata },
          });
          return { context };
        },
      },
    },
    {
      async loadConfig() {
        return {
          path: join(configDirectory, "config.json"),
          providers: {
            deepseek: {
              adapter: "deepseek-chat",
              apiKey: "test",
            },
          },
          models: {
            chat: {
              provider: "deepseek",
              model: "deepseek-chat",
              contextWindowTokens: 64000,
              maxOutputTokens: 4096,
            },
          },
          defaultModel: "chat",
          apps: {
            maybecode: {
              instructionsDirectory: "instructions/maybecode",
            },
          },
        };
      },
      createModel(selection) {
        selected = selection;
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
    },
  );

  assert.equal(selected.model, "deepseek-chat");
  assert.deepEqual(app.modelInfo, {
    profile: "chat",
    provider: "deepseek",
    adapter: "deepseek-chat",
    model: "deepseek-chat",
  });
  assert.equal(
    (await (await app.submit({ input: "hello" })).result).message.content[0]
      .text,
    "ok",
  );
  assert.match(
    request.messages[0].content[0].text,
    /^custom system\n\n# Runtime environment\n\n/u,
  );
  assert.match(
    request.messages[0].content[0].text,
    /\n\n# Project instructions\n\nproject rules$/u,
  );
  assert.equal(app.instructions.system.source.type, "file");
  assert.equal(app.instructions.runtime.source.type, "runtime");
  assert.equal(app.instructions.project.source.type, "file");
  assert.deepEqual(contextOptions.metadata, { workspace: await realpath(directory) });
  assert.deepEqual(contextOptions.budget, {
    contextWindowTokens: 64000,
    outputReserveTokens: 4096,
    compactTriggerRatio: 0.9,
  });
  assert.deepEqual(
    contextOptions.autoCompactionStrategies.map((strategy) => strategy.name),
    ["prune-old-tool-results", "summary-tail", "history-reference"],
  );
  await app.close();
});

test("adds configured MCP tools and owns the client pool lifecycle", async (t) => {
  const directory = await temporaryDirectory(t);
  let openedWith;
  let mockPool;
  const refreshed = [];
  let request;
  let closed = false;
  let releaseEvents;
  const app = await openConfiguredMaybeCode(
    {
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
    },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: { local: { adapter: "test", apiKey: "test" } },
          models: { chat: { provider: "local", model: "test" } },
          defaultModel: "chat",
          apps: {
            maybecode: {
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
        return mockPool = {
          async refresh(id) { refreshed.push(["refresh", id]); },
          async reconnect(id) { refreshed.push(["reconnect", id]); },
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
          tools: [{
            name: "mcp__local__lookup",
            description: "lookup",
            inputSchema: { type: "object" },
            async execute() {
              return { content: [{ type: "text", text: "found" }] };
            },
          }],
          status() {
            return [{
              serverId: "local",
              transport: "stdio",
              required: true,
              state: "connected",
              toolNames: ["mcp__local__lookup"],
            }];
          },
          async close() {
            closed = true;
            releaseEvents();
          },
        };
      },
    },
  );

  assert.deepEqual(openedWith.servers, [{
    id: "local",
    command: "test-server",
    args: ["--stdio"],
    cwd: await realpath(directory),
  }]);
  assert.equal((await app.getMcpStatus())[0].state, "connected");
  assert.equal(
    (await executeMaybeCodeSlashCommand("/mcp", app)).type,
    "mcp.status",
  );
  const observedEvents = [];
  const eventTask = (async () => {
    for await (const event of app.events) observedEvents.push(event);
  })();
  await (await app.submit({ input: "hello" })).result;
  assert.ok(request.tools.some((tool) => tool.name === "read"));
  assert.ok(request.tools.some((tool) => tool.name === "mcp__local__lookup"));
  mockPool.tools = [{ ...mockPool.tools[0], name: "mcp__local__updated" }];
  await (await app.submit({ input: "next run" })).result;
  assert.ok(request.tools.some((tool) => tool.name === "mcp__local__updated"));
  assert.ok(!request.tools.some((tool) => tool.name === "mcp__local__lookup"));
  await executeMaybeCodeSlashCommand("/mcp refresh local", app);
  await executeMaybeCodeSlashCommand("/mcp reconnect local", app);
  assert.deepEqual(refreshed, [["refresh", "local"], ["reconnect", "local"]]);
  await app.close();
  await eventTask;
  assert.equal(closed, true);
  assert.deepEqual(
    observedEvents
      .filter((event) => event.type.startsWith("mcp.server."))
      .map((event) => event.type),
    ["mcp.server.connected", "mcp.server.disconnected"],
  );
});

test("writes configured content-free traces and flushes them on close", async (t) => {
  const directory = await temporaryDirectory(t);
  const dataDirectory = join(directory, "data");
  const traceDirectory = join(dataDirectory, "telemetry");
  const app = await openConfiguredMaybeCode(
    { workspace: directory, dataDirectory, autoResume: false },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            local: { adapter: "test", apiKey: "do-not-capture" },
          },
          models: {
            chat: { provider: "local", model: "test-model" },
          },
          defaultModel: "chat",
          apps: {
            maybecode: {
              retry: false,
              observability: {
                enabled: true,
                exporter: "file",
                file: "telemetry/traces.jsonl",
                samplingRatio: 1,
                batch: { scheduledDelayMs: 60_000 },
              },
            },
          },
        };
      },
      createModel() {
        return {
          async *stream() {
            yield {
              type: "response.completed",
              message: assistantMessage("private answer"),
            };
          },
        };
      },
    },
  );

  await (await app.submit({ input: "private prompt" })).result;
  const sessionId = app.sessionId;
  await app.close();

  const traceFiles = (await readdir(traceDirectory)).filter((name) =>
    /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)
  );
  assert.equal(traceFiles.length, 1);
  const content = await readFile(join(traceDirectory, traceFiles[0]), "utf8");
  const spans = content.trim().split("\n").map((line) => JSON.parse(line));
  const run = spans.find((span) => span.name === "may.run");
  assert.ok(run);
  assert.equal(run.attributes["service.name"], "maybecode");
  assert.equal(run.attributes["may.agent.name"], "maybecode");
  assert.equal(run.attributes["may.model.profile"], "chat");
  assert.equal(run.attributes["may.session.id"], sessionId);
  assert.doesNotMatch(content, /private prompt|private answer|do-not-capture/u);
});

test("resolves and validates MaybeCode observability configuration", () => {
  const base = { path: "config.json", providers: {}, models: {} };
  assert.equal(resolveMaybeCodeObservability(base), false);
  assert.equal(resolveMaybeCodeObservability({
    ...base,
    apps: { maybecode: { observability: { enabled: false } } },
  }), false);
  assert.deepEqual(resolveMaybeCodeObservability({
    ...base,
    apps: {
      maybecode: {
        observability: {
          file: "trace/output.jsonl",
          samplingRatio: 0.25,
          retentionDays: 30,
          batch: { maxQueueSize: 32, maxExportBatchSize: 8 },
        },
      },
    },
  }), {
    file: "trace/output.jsonl",
    samplingRatio: 0.25,
    retentionDays: 30,
    maxQueueSize: 32,
    maxExportBatchSize: 8,
  });
  assert.throws(() => resolveMaybeCodeObservability({
    ...base,
    apps: {
      maybecode: {
        observability: {
          batch: { maxQueueSize: 8, maxExportBatchSize: 9 },
        },
      },
    },
  }), /maxExportBatchSize cannot exceed maxQueueSize/u);
  assert.throws(() => resolveMaybeCodeObservability({
    ...base,
    apps: { maybecode: { observability: { destination: "somewhere" } } },
  }), /observability\.destination is not supported/u);
});

test("resolves workspace-relative MCP servers and environment references", () => {
  const workspace = join(process.cwd(), "workspace");
  const base = { path: "config.json", providers: {}, models: {} };
  assert.equal(resolveMaybeCodeMcp(base, workspace), false);
  assert.deepEqual(resolveMaybeCodeMcp({
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
  }, workspace, { MCP_TOKEN: "secret" }), {
    servers: [{
      id: "files",
      command: "node",
      required: false,
      args: ["server.mjs", "--root", "."],
      cwd: join(workspace, "tools"),
      env: { TOKEN: "Bearer secret" },
      requestTimeoutMs: 1_000,
      stderrMaxBytes: 2_048,
    }],
  });
  assert.throws(() => resolveMaybeCodeMcp({
    ...base,
    apps: {
      maybecode: {
        mcpServers: {
          files: { command: "node", env: { TOKEN: "${MISSING}" } },
        },
      },
    },
  }, workspace, {}), /missing environment variable MISSING/u);
});

test("resolves HTTP MCP headers, validates transport options, and formats protocol status", () => {
  const workspace = process.cwd();
  const base = { path: "config.json", providers: {}, models: {} };
  const config = (remote) => ({
    ...base, apps: { maybecode: { mcpServers: { remote } } },
  });
  const endpoint = {
    transport: "streamable-http", url: "https://mcp.example.com/mcp",
    headers: { Authorization: "Bearer ${MCP_TOKEN}" }, protocolMode: "auto",
    required: false, requestTimeoutMs: 1_000,
  };
  assert.deepEqual(resolveMaybeCodeMcp(config(endpoint), workspace, { MCP_TOKEN: "secret" }), {
    servers: [{ ...endpoint, id: "remote", headers: { Authorization: "Bearer secret" } }],
  });
  assert.throws(() => resolveMaybeCodeMcp(config(endpoint), workspace, {}), /missing environment variable MCP_TOKEN/u);
  for (const change of [
    { cwd: "." }, { command: "node" }, { stderrMaxBytes: 1_024 },
    { url: "http://example.com" }, { transport: "sse" }, { protocolMode: "pin" },
    { headers: { Host: "spoof" } },
  ]) {
    assert.throws(() => resolveMaybeCodeMcp(config({ ...endpoint, ...change }), workspace, { MCP_TOKEN: "secret" }));
  }
  assert.throws(() => resolveMaybeCodeMcp(config({ command: "node", headers: {} }), workspace), /requires streamable-http/u);
  assert.match(formatMaybeCodeMcpStatus([{
    serverId: "remote", transport: "streamable-http", required: false,
    state: "connected", protocolVersion: "2026-07-28", toolNames: ["mcp__remote__lookup"],
  }]), /optional, streamable-http\)\n  protocol: 2026-07-28/u);
});

test("MCP login commands run before model startup and accept OAuth configuration", async () => {
  const command = parseMaybeCodeArgs(["mcp", "login", "remote", "--config", "auth.json", "--scope", "write"]);
  assert.deepEqual(command, { type: "mcp", action: "login", serverId: "remote", configPath: "auth.json", scopes: ["write"] });
  assert.throws(() => parseMaybeCodeArgs(["mcp", "logout", "remote", "--scope", "write"]));
  const configured = {
    path: "auth.json", providers: {}, models: {},
    apps: { maybecode: { mcpServers: { remote: {
      transport: "streamable-http", url: "https://mcp.example.com/mcp",
      auth: { type: "oauth", scopes: ["read"], authorizationOrigins: ["https://accounts.example.com"] },
    } } } },
  };
  const output = [];
  let loggedIn;
  const deps = {
    write: (text) => output.push(text), loadConfig: async () => configured,
    oauth: { async login(server) { loggedIn = server; } },
  };
  await runMaybeCodeMcpCommand(command, deps);
  assert.deepEqual(loggedIn.auth.scopes, ["read", "write"]);
  assert.match(output.join(""), /login complete/u);
  const code = await runMaybeCode(["mcp", "status", "remote"], {
    terminal: { write: (text) => output.push(text), close() {} },
    open: () => { throw new Error("Agent must not start"); },
    mcpAuth: async (value) => { assert.equal(value.action, "status"); },
  });
  assert.equal(code, 0);
  configured.apps.maybecode.mcpServers.remote.auth.clientId = "public-client";
  assert.throws(() => resolveMaybeCodeMcp(configured, process.cwd()), /requires expectedIssuer/u);
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

test("switches configured model profiles by prefix without changing sessions", async (t) => {
  const directory = await temporaryDirectory(t);
  const created = [];
  const persistedDefaults = [];
  const app = await openConfiguredMaybeCode(
    {
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
    },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            cliproxy: {
              adapter: "openai-responses",
              apiKey: "test",
            },
          },
          models: {
            "cliproxy-low": {
              provider: "cliproxy",
              model: "gpt-model",
              options: { reasoningEffort: "low" },
            },
            "cliproxy-high": {
              provider: "cliproxy",
              model: "gpt-model",
              options: { reasoningEffort: "high" },
            },
          },
          defaultModel: "cliproxy-high",
          apps: { maybecode: { retry: false } },
        };
      },
      createModel(selection) {
        created.push(selection.profile);
        return {
          async *stream() {
            yield {
              type: "response.completed",
              message: assistantMessage(selection.profile),
            };
          },
        };
      },
      async persistDefaultModel(profile) {
        persistedDefaults.push(profile);
      },
    },
  );

  const sessionId = app.sessionId;
  await (await app.submit({ input: "before" })).result;
  const suggest = createMaybeCodeSlashCommandSuggester(app);
  assert.deepEqual(
    (await suggest("/model cliproxy-")).map((item) => item.label),
    ["cliproxy-low", "cliproxy-high"],
  );

  assert.deepEqual(
    (await suggest("/model clip ")).map((item) => item.label),
    ["--default"],
  );
  const switched = await executeMaybeCodeSlashCommand(
    "/model clip --default",
    app,
  );
  assert.equal(switched.type, "model.switched");
  assert.equal(switched.profile, "cliproxy-low");
  assert.equal(app.sessionId, sessionId);
  assert.equal(app.modelInfo.profile, "cliproxy-low");
  assert.deepEqual(created, ["cliproxy-high", "cliproxy-low"]);
  assert.deepEqual(persistedDefaults, ["cliproxy-low"]);
  assert.deepEqual(
    (await app.listModels()).filter((model) => model.isDefault)
      .map((model) => model.name),
    ["cliproxy-low"],
  );
  assert.equal(
    (await (await app.submit({ input: "after" })).result).message.content[0].text,
    "cliproxy-low",
  );
  assert.equal(
    (await executeMaybeCodeSlashCommand("/model", app)).type,
    "model.selection.requested",
  );
  await app.close();
});

test("switches supported reasoning effort without duplicating model profiles", async (t) => {
  const directory = await temporaryDirectory(t);
  const createdEfforts = [];
  const app = await openConfiguredMaybeCode(
    {
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
    },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            deepseek: { adapter: "deepseek-chat", apiKey: "test" },
          },
          models: {
            reasoner: {
              provider: "deepseek",
              model: "deepseek-v4-pro",
            },
          },
          defaultModel: "reasoner",
          apps: { maybecode: { retry: false } },
        };
      },
      createModel(selection) {
        createdEfforts.push(selection.options.reasoningEffort);
        return {
          async *stream() {
            yield {
              type: "response.completed",
              message: assistantMessage("ok"),
            };
          },
        };
      },
    },
  );

  const sessionId = app.sessionId;
  const suggest = createMaybeCodeSlashCommandSuggester(app);
  assert.deepEqual(
    (await suggest("/effort ")).map((item) => item.label),
    ["default", "low", "high", "max"],
  );
  const changed = await executeMaybeCodeSlashCommand("/effort m", app);
  assert.equal(changed.type, "effort.changed");
  assert.equal(changed.state.effectiveEffort, "max");
  assert.equal(changed.state.source, "builtin");
  assert.equal(app.sessionId, sessionId);

  const restored = await executeMaybeCodeSlashCommand("/effort default", app);
  assert.equal(restored.type, "effort.changed");
  assert.equal(restored.state.effectiveEffort, "high");
  assert.deepEqual(createdEfforts, [undefined, "max", undefined]);
  await app.close();
});

test("does not enable provider-native automatic compaction by default", async (t) => {
  const opened = await openWithCapturedOpenAIContext(t, {});

  assert.deepEqual(opened.strategyNames, [
    "prune-old-tool-results",
    "summary-tail",
    "history-reference",
  ]);
  await opened.app.close();
});

test("adds explicitly enabled provider-native compaction after prune", async (t) => {
  const opened = await openWithCapturedOpenAIContext(t, {
    maybecode: { autoCompaction: { providerNative: true } },
  });

  assert.deepEqual(opened.strategyNames, [
    "prune-old-tool-results",
    "openai-responses-compact",
    "summary-tail",
    "history-reference",
  ]);
  await opened.app.close();
});

test("validates provider-native automatic compaction configuration", async (t) => {
  await assert.rejects(
    openWithCapturedOpenAIContext(t, {
      maybecode: { autoCompaction: { providerNative: "yes" } },
    }),
    /apps\.maybecode\.autoCompaction\.providerNative must be a boolean/,
  );
  await assert.rejects(
    openWithCapturedOpenAIContext(t, {
      maybecode: { autoCompaction: true },
    }),
    /apps\.maybecode\.autoCompaction must be an object/,
  );
});

test("resolves and validates MaybeCode model retry configuration", () => {
  const base = { path: "config.json", providers: {}, models: {} };
  assert.deepEqual(resolveMaybeCodeRetry(base), {});
  assert.equal(resolveMaybeCodeRetry({
    ...base,
    apps: { maybecode: { retry: false } },
  }), false);
  assert.deepEqual(resolveMaybeCodeRetry({
    ...base,
    apps: {
      maybecode: {
        retry: {
          maxAttempts: 4,
          baseDelayMs: 100,
          maxDelayMs: 2000,
          jitterRatio: 0.1,
        },
      },
    },
  }), {
    maxAttempts: 4,
    baseDelayMs: 100,
    maxDelayMs: 2000,
    jitterRatio: 0.1,
  });
  assert.throws(() => resolveMaybeCodeRetry({
    ...base,
    apps: { maybecode: { retry: { maxAttempts: 0 } } },
  }), /maxAttempts must be a positive safe integer/u);
  assert.throws(() => resolveMaybeCodeRetry({
    ...base,
    apps: { maybecode: { retry: { baseDelayMs: 9000 } } },
  }), /baseDelayMs cannot exceed maxDelayMs/u);
});

test("configured MaybeCode automatically retries transient model failures", async (t) => {
  const directory = await temporaryDirectory(t);
  let attempts = 0;
  const app = await openConfiguredMaybeCode(
    {
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
    },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            deepseek: { adapter: "deepseek-chat", apiKey: "test" },
          },
          models: {
            chat: { provider: "deepseek", model: "deepseek-chat" },
          },
          defaultModel: "chat",
          apps: {
            maybecode: {
              retry: {
                maxAttempts: 2,
                baseDelayMs: 0,
                maxDelayMs: 0,
                jitterRatio: 0,
              },
            },
          },
        };
      },
      createModel() {
        return {
          async *stream() {
            attempts += 1;
            if (attempts === 1) {
              throw Object.assign(new Error("service unavailable"), {
                status: 503,
              });
            }
            yield {
              type: "response.completed",
              message: assistantMessage("recovered"),
            };
          },
        };
      },
    },
  );

  const result = await (await app.submit({ input: "hello" })).result;
  assert.equal(result.message.content[0].text, "recovered");
  assert.equal(attempts, 2);
  await app.close();
});

test(
  "explains Windows drive-relative paths mangled by Git Bash",
  { skip: process.platform !== "win32" },
  async () => {
    for (const workspace of ["E:codeept", "E:"]) {
      await assert.rejects(
        openConfiguredMaybeCode(
          { workspace },
          {
            async loadConfig() {
              throw new Error("config should not be loaded");
            },
          },
        ),
        /Git Bash removes unquoted backslashes.*E:\/code\/project/u,
      );
    }
  },
);

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function openWithCapturedOpenAIContext(t, apps) {
  const directory = await temporaryDirectory(t);
  let contextOptions;
  const app = await openConfiguredMaybeCode(
    {
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
      contextFactory: {
        create(options) {
          contextOptions = options;
          return {
            context: new InMemoryContext({
              instructions: options.instructions,
              messages: [...(options.messages ?? [])],
              metadata: { ...options.metadata },
            }),
          };
        },
      },
    },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            openai: {
              adapter: "openai-responses",
              apiKey: "test",
            },
          },
          models: {
            gpt: {
              provider: "openai",
              model: "gpt-5.4",
              contextWindowTokens: 128_000,
              maxOutputTokens: 8192,
            },
          },
          defaultModel: "gpt",
          apps,
        };
      },
    },
  );
  return {
    app,
    strategyNames: contextOptions.autoCompactionStrategies.map(
      (strategy) => strategy.name,
    ),
  };
}
