import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { applicationServices } from "@sortedyuan/may";
import { InMemoryContext, ToolUsageError } from "@sortedyuan/may/core";
import { FileSessionStore } from "@sortedyuan/may/session/file-store";
import { AnthropicModel, KimiFormulaError, OpenAIResponsesModel } from "@sortedyuan/providers";
import { UiProjection } from "@sortedyuan/ui-client/projection";
import { recordedField } from "@sortedyuan/ui-client/reading";
import { resolveSubagentConfiguration } from "@sortedyuan/coordination/delegation/configuration";
import { createDeepSeekSearchBackend, createWebSearchTool } from "@sortedyuan/coding-tools";
import { workspaceFilesService } from "@sortedyuan/coordination/delegation";
import { TranscriptStore } from "@sortedyuan/tui/transcript";
import { createCodingToolRendererRegistry, readCodingToolPresentation } from "@sortedyuan/tui/tool-renderers";
import { DEFAULT_DARK_THEME } from "@sortedyuan/tui";
import { MaybeCodeApplication } from "../dist/application.js";
import { createMaybeCodeToolPresentation } from "../dist/tool-presentation.js";
import { executeMaybeCodeSlashCommand } from "../dist/slash-commands.js";
import { readMaybeCodeSettings } from "../dist/settings.js";
import { createCodingPermissionPolicy } from "../dist/policy.js";
import { searchStatus } from "../dist/search.js";
import { TeamExecutionEnvironments } from "../dist/team-execution.js";
import { openConfiguredMaybeCode } from "../dist/configured.js";
import { createMaybeCodeModel } from "../dist/model.js";
import { createTestWorkspace } from "./fixtures/workspace.mjs";

const context = (toolCallId = "integration") => ({
  runId: "integration",
  step: 1,
  toolCallId,
  idempotencyKey: toolCallId,
  signal: new AbortController().signal,
  report() {},
});
const model = () => new OpenAIResponsesModel({ apiKey: "offline-construction-only", model: "gpt-4.1" });

async function lspSettings() {
  const require = createRequire(new URL("../../../packages/tools/lsp/package.json", import.meta.url));
  const manifest = require.resolve("typescript-language-server/package.json");
  const { bin } = JSON.parse(await readFile(manifest, "utf8"));
  return {
    servers: {
      typescript: {
        command: process.execPath,
        args: [join(dirname(manifest), bin["typescript-language-server"]), "--stdio"],
        initializationOptions: { tsserver: { path: require.resolve("typescript/lib/tsserver.js") } },
      },
    },
    diagnosticsTimeoutMs: 15000,
    requestTimeoutMs: 30000,
  };
}

async function application(t, options = {}) {
  const workspace = await createTestWorkspace(t);
  const app = await MaybeCodeApplication.open({
    workspace,
    model: model(),
    dataDirectory: join(workspace, ".data"),
    store: new FileSessionStore(join(workspace, ".sessions")),
    requestRecording: "off",
    skills: false,
    goals: false,
    subagents: false,
    ...options,
  });
  t.after(() => app.close());
  return { workspace, app, tools: [...app.agent.getService(applicationServices.toolSources).snapshot()] };
}

test(
  "MaybeCode uses a real language server for edit feedback, rename approval and scoped child tools",
  { timeout: 120000 },
  async (t) => {
    const webSearch = createWebSearchTool({
      backend: createDeepSeekSearchBackend({ apiKey: "offline-construction-only" }),
    });
    const { workspace, app, tools } = await application(t, { lsp: await lspSettings(), toolSource: () => [webSearch] });
    await writeFile(
      join(workspace, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext" },
        include: ["*.ts"],
      }),
    );
    await writeFile(join(workspace, "a.ts"), "export function greet(name: string): string { return name; }\n");
    await writeFile(
      join(workspace, "b.ts"),
      'import { greet } from "./a.js";\nexport const result = greet("hello");\n',
    );
    await writeFile(join(workspace, "error.ts"), "export const count: number = 1;\n");
    const edit = tools.find((tool) => tool.name === "edit");
    const output = await edit.execute({ path: "error.ts", oldText: "= 1", newText: '= "wrong"' }, context());
    assert.ok(
      output.diagnostics.items.some((item) => item.severity === "error"),
      JSON.stringify(output),
    );
    const status = await executeMaybeCodeSlashCommand("/lsp", { application: app });
    assert.equal(status.type, "display");
    assert.match(status.text, /typescript.*apps\.maybecode\.lsp\.servers\.typescript.*running/u);
    const rename = tools.find((tool) => tool.name === "lsp_rename");
    const check = {
      tool: rename,
      input: { path: "a.ts", line: 1, symbol: "greet", newName: "welcome" },
      context: context("rename"),
    };
    const preview = await createMaybeCodeToolPresentation(workspace, app.lsp, check);
    assert.equal(preview.kind, "maybecode.lsp-rename-preview");
    assert.equal(preview.data.files.length, 2);
    const transcript = new TranscriptStore();
    transcript.applySessionEvent({
      type: "tool.presentation",
      sessionId: app.sessionId,
      seq: 1,
      timestamp: 1,
      runId: "integration",
      step: 1,
      toolCallId: "rename",
      ...preview,
    });
    const item = transcript.items.find((entry) => entry.kind === "tool");
    const rendered = createCodingToolRendererRegistry().render(item, {
      expanded: true,
      maximumOutputCharacters: 65536,
      theme: DEFAULT_DARK_THEME,
    });
    assert.match(rendered, /a\.ts/u);
    assert.match(rendered, /b\.ts/u);
    assert.match(rendered, /welcome/u);
    const liveTranscript = new TranscriptStore();
    liveTranscript.appendToolPresentation({ runId: "integration", step: 1, toolCallId: "rename", ...preview });
    assert.equal(readCodingToolPresentation(liveTranscript.items[0]).previews.length, 2);
    const renamed = await rename.execute(check.input, check.context);
    assert.equal(renamed.files.length, 2);
    assert.match(await readFile(join(workspace, "b.ts"), "utf8"), /welcome/u);
    const roles = resolveSubagentConfiguration({ roles: { worker: { tools: ["lsp_definition", "web_search"] } } });
    const child = app.agent
      .getService(workspaceFilesService)
      .create({ names: roles.roles[0].tools, requireRead: true, files: [] });
    assert.deepEqual(
      child.tools.map((tool) => tool.name),
      ["lsp_definition", "web_search"],
    );
    const definition = await child.tools[0].execute(
      { path: "b.ts", line: 2, symbol: "welcome" },
      context("definition"),
    );
    assert.equal(definition.locations[0].path, "a.ts");
    assert.equal(child.tools[1].permissionVersion, webSearch.permissionVersion);
    const projection = new UiProjection();
    const presentation = {
      type: "tool.presentation",
      sessionId: app.sessionId,
      seq: 1,
      timestamp: 1,
      runId: "integration",
      step: 1,
      toolCallId: "rename",
      ...preview,
    };
    projection.history([presentation]);
    const displayed = projection.blocks.get("tool:integration:rename");
    assert.match(displayed.presentation.text, /a\.ts\n/u);
    assert.match(displayed.presentation.text, /b\.ts\n/u);
    assert.equal(recordedField([presentation], displayed, "presentation"), displayed.presentation.text);
    const liveProjection = new UiProjection();
    liveProjection.event({
      type: "tool.presentation",
      presentation: { runId: "integration", step: 1, toolCallId: "rename", ...preview },
    });
    assert.equal(liveProjection.blocks.get("tool:integration:rename").presentation.text, displayed.presentation.text);
    const pid = app.lsp.status()[0].pid;
    await app.close();
    assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  },
);

test(
  "recorded model requests preserve failed tool usage, budgets, history and search sources",
  { timeout: 120000 },
  async (t) => {
    const recording = await readFile(
      new URL("../../../packages/providers/test/fixtures/search/anthropic-mixed-0.sse", import.meta.url),
    );
    const usage = { items: [{ id: "web-search", quantity: 1, unit: "requests", includedIn: "none" }] };
    for (const maxCostUsd of [1, 0.01, undefined]) {
      const charged =
        maxCostUsd === undefined
          ? { completeness: { status: "partial", reason: "host-search-outcome-unknown" } }
          : usage;
      let requests = 0;
      const provider = new AnthropicModel({
        apiKey: "recording-replay-only",
        model: "codex/gpt-6-luna",
        webSearch: { version: "web_search_20260209", allowedCallers: ["direct"] },
        fetch: async () => {
          requests += 1;
          assert.equal(requests, 1, "The Run yields after executing the recorded tool call");
          return new Response(recording, { headers: { "content-type": "text/event-stream" } });
        },
      });
      const failing = {
        name: "add",
        description: "Add two numbers",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        async execute() {
          const error = new KimiFormulaError("Charged tool execution failed", "failed", "usage-test", {
            usage: charged,
          });
          assert.ok(error instanceof ToolUsageError);
          throw error;
        },
      };
      const { app } = await application(t, { model: provider, tools: [failing], permissionPolicy: () => "allow" });
      const live = [];
      const relay = (async () => {
        for await (const event of app.events) if (event.type === "run.event") live.push(event.event);
      })();
      try {
        const pricing = {
          id: "tool-usage-test",
          version: "1",
          currency: "USD",
          source: "test",
          effectiveAt: "2026-11-07T00:00:00Z",
          inputPerMillion: 0,
          outputPerMillion: 0,
          cachedReadPerMillion: 0,
          cachedWritePerMillion: 0,
          reasoningPerMillion: 0,
          items: { "web-search": { unit: "requests", perUnit: 0.1 } },
        };
        const run = await app.submit({
          input: "Search and calculate 124 + 219 using add.",
          shouldYield: () => true,
          ...(maxCostUsd === undefined ? {} : { runBudget: { maxCostUsd, pricing } }),
        });
        if (maxCostUsd === 0.01) await assert.rejects(run.result, { dimension: "costUsd", consumed: 0.1 });
        else {
          const result = await run.result;
          assert.equal(result.finishReason, "yielded");
          if (maxCostUsd === undefined) assert.equal(result.usage.completeness.status, "partial");
          else {
            assert.deepEqual(result.usage.items, usage.items);
            assert.equal(result.budget.costUsd, 0.1);
          }
        }
        const history = await app.history();
        assert.deepEqual(history.find((event) => event.type === "tool.failed").usage, charged);
        const projection = new UiProjection();
        projection.history(history);
        const transcript = new TranscriptStore();
        transcript.loadHistory(history);
        const message = history.find((event) => event.type === "assistant.completed").message;
        const url = message.serverToolCalls.flatMap((call) => call.sources ?? [])[0].url;
        assert.ok([...projection.blocks.values()].some((block) => block.text.includes(url)));
        assert.ok(transcript.items.some((item) => "text" in item && item.text.includes(url)));
        const assistant = [...projection.blocks.values()].find((block) => block.kind === "assistant");
        assert.ok(recordedField(history, assistant, "text").includes(url));
      } finally {
        await app.close();
        await relay;
      }
      assert.deepEqual(live.find((event) => event.type === "tool.failed").usage, charged);
      const projected = new UiProjection();
      const transcript = new TranscriptStore();
      for (const event of live) {
        projected.event({ type: "run.event", event });
        transcript.applyMayEvent(event);
      }
      const completed = live.find((event) => event.type === "model.completed");
      const search = completed.message.serverToolCalls[0];
      assert.equal(projected.blocks.get(`server-tool:${search.id}`).status, search.status);
      assert.equal(transcript.items.filter((item) => item.id === `server-tool:${search.id}`).length, 1);
    }
  },
);

test("MaybeCode omits LSP tools and edit diagnostics when unconfigured", async (t) => {
  const { workspace, app, tools } = await application(t);
  assert.equal(
    tools.some((tool) => tool.name.startsWith("lsp_")),
    false,
  );
  await writeFile(join(workspace, "plain.ts"), "const count = 1;\n");
  const output = await tools
    .find((tool) => tool.name === "edit")
    .execute({ path: "plain.ts", oldText: "1", newText: "2" }, context());
  assert.equal(output.diagnostics, undefined);
  const status = await executeMaybeCodeSlashCommand("/lsp", { application: app });
  assert.match(status.text, /apps\.maybecode\.lsp\.servers/u);
});

test("MaybeCode rejects model replacement while its actual Context has a pending server interaction", async (t) => {
  const current = new InMemoryContext();
  const { app } = await application(t, { contextFactory: { create: () => ({ context: current }) } });
  await current.append([
    {
      role: "assistant",
      content: [],
      serverToolCalls: [{ id: "search", kind: "web_search", name: "web_search", status: "pending" }],
    },
  ]);
  await assert.rejects(
    app.updateModel({ model: model(), modelInfo: { provider: "openai", model: "gpt-4.1" } }),
    /Continue the pending server tool interaction/u,
  );
  await current.append([{ role: "assistant", content: [{ type: "text", text: "complete" }] }]);
  await app.updateModel({ model: model(), modelInfo: { provider: "openai", model: "gpt-4.1" } });
});

test("MaybeCode validates LSP registrations, search credentials and search permission scope", async () => {
  const config = (maybecode) => ({ path: "test.json", providers: {}, models: {}, apps: { maybecode } });
  assert.throws(() => readMaybeCodeSettings(config({ lsp: { servers: { custom: {} } } })), /command and languages/u);
  assert.throws(
    () =>
      readMaybeCodeSettings(
        config({
          lsp: { servers: { typescript: {}, duplicate: { command: "node", languages: { typescript: [".ts"] } } } },
        }),
      ),
    /duplicate extension/u,
  );
  assert.throws(
    () => readMaybeCodeSettings(config({ subagents: { roles: { worker: { tools: ["lsp_definition"] } } } })),
    /unregistered tool/u,
  );
  assert.throws(
    () => readMaybeCodeSettings(config({ webSearch: { hostTool: { backend: "deepseek", provider: "missing" } } })),
    /unknown provider/u,
  );
  const tool = createWebSearchTool({ backend: createDeepSeekSearchBackend({ apiKey: "offline-construction-only" }) });
  const policy = createCodingPermissionPolicy({ persistent: { workspace: process.cwd(), scopeId: "workspace" } });
  const decision = await policy({ tool, input: { query: "May" }, context: context() });
  assert.equal(decision.grantKey, `web-search:${tool.permissionVersion}`);
  assert.equal(decision.persistent.scopeId, "workspace");
  for (const name of [
    "lsp_definition",
    "lsp_diagnostics",
    "lsp_references",
    "lsp_hover",
    "lsp_document_symbols",
    "lsp_workspace_symbols",
  ]) {
    assert.equal(
      await createCodingPermissionPolicy({ readOnly: true })({
        tool: { ...tool, name },
        input: {},
        context: context(),
      }),
      "allow",
    );
  }
  assert.equal(
    await createCodingPermissionPolicy({ readOnly: true })({
      tool: { ...tool, name: "lsp_rename" },
      input: {},
      context: context(),
    }),
    "deny",
  );
  assert.equal(searchStatus(false, "openai-responses", { webSearch: {} }), "Search disabled");
  assert.equal(
    searchStatus({ hostTool: { backend: "kimi-formula", provider: "kimi" } }, "deepseek-chat", {}),
    "Kimi Formula search requires kimi-chat",
  );
});

test(
  "team worktrees own separate language server managers and close their processes",
  { timeout: 120000 },
  async (t) => {
    const first = await createTestWorkspace(t),
      second = await createTestWorkspace(t);
    const environments = new TeamExecutionEnvironments({ mode: "host" }, await lspSettings(), join(first, ".data"));
    t.after(() => environments.close());
    const left = await environments.languageServers(first),
      right = await environments.languageServers(second);
    assert.notEqual(left, right);
    assert.equal(await environments.languageServers(first), left);
    await writeFile(join(first, "a.ts"), "export const first = 1;\n");
    await writeFile(join(second, "b.ts"), "export const second = 2;\n");
    await left.documentSymbols("a.ts", context().signal);
    await right.documentSymbols("b.ts", context().signal);
    const pids = [left.status()[0].pid, right.status()[0].pid];
    assert.notEqual(pids[0], pids[1]);
    await environments.close();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/u);
  },
);

test("configured MaybeCode selects host search per model and enforces webSearch: false", async (t) => {
  const workspace = await createTestWorkspace(t);
  const configPath = join(workspace, "may.json");
  const configured = {
    providers: {
      openai: { adapter: "openai-responses", apiKey: "offline-construction-only", options: { webSearch: {} } },
      deepseek: { adapter: "deepseek-chat", apiKey: "offline-construction-only" },
    },
    models: {
      server: { provider: "openai", model: "gpt-4.1" },
      plain: { provider: "openai", model: "gpt-4.1", options: { webSearch: false } },
      deepseek: { provider: "deepseek", model: "deepseek-chat" },
    },
    defaultModel: "server",
    apps: {
      maybecode: {
        webSearch: { hostTool: { backend: "deepseek", provider: "deepseek" } },
        git: false,
        subagents: false,
        skills: false,
        requestRecording: "off",
        retry: false,
        observability: false,
      },
    },
  };
  await writeFile(configPath, JSON.stringify(configured));
  const app = await openConfiguredMaybeCode({
    workspace,
    configPath,
    dataDirectory: join(workspace, ".data"),
    goals: false,
  });
  const tools = () => [...app.application.agent.getService(applicationServices.toolSources).snapshot()];
  try {
    assert.equal(
      tools().some((tool) => tool.name === "web_search"),
      false,
    );
    assert.match(app.application.modelInfo.searchStatus, /Server search enabled/u);
    await app.switchModel("plain");
    assert.equal(tools().filter((tool) => tool.name === "web_search").length, 1);
    assert.match(app.application.modelInfo.searchStatus, /Host search: deepseek/u);
    await app.switchModel("server");
    assert.equal(
      tools().some((tool) => tool.name === "web_search"),
      false,
    );
  } finally {
    await app.close();
  }
  configured.apps.maybecode.webSearch = false;
  await writeFile(configPath, JSON.stringify(configured));
  let selectedOptions;
  const disabled = await openConfiguredMaybeCode(
    { workspace, configPath, dataDirectory: join(workspace, ".disabled"), goals: false },
    {
      createModel(selection) {
        selectedOptions = selection.options;
        return createMaybeCodeModel(selection);
      },
    },
  );
  try {
    assert.equal(disabled.application.modelInfo.searchStatus, "Search disabled");
    assert.equal(
      [...disabled.application.agent.getService(applicationServices.toolSources).snapshot()].some(
        (tool) => tool.name === "web_search",
      ),
      false,
    );
    assert.equal(selectedOptions.webSearch, false);
    await disabled.switchModel("deepseek");
    assert.equal(disabled.application.modelInfo.searchStatus, "Search disabled");
  } finally {
    await disabled.close();
  }
  configured.providers.openai.adapter = "openai-chat-completions";
  configured.models.server.model = "gpt-5-search-api";
  configured.providers.openai.options = {};
  await writeFile(configPath, JSON.stringify(configured));
  await assert.rejects(
    openConfiguredMaybeCode({ workspace, configPath, dataDirectory: join(workspace, ".rejected"), goals: false }),
    /conflicts with webSearch: false/u,
  );
});
