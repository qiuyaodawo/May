import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext } from "@may/core";

import {
  createMaybeCodeSlashCommandSuggester,
  createMaybeCodeModel,
  executeMaybeCodeSlashCommand,
  openConfiguredMaybeCode,
  parseMaybeCodeArgs,
  resolveMaybeCodeRetry,
  selectMaybeCodeModel,
} from "../dist/index.js";

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

test("selects the default model profile", () => {
  const selection = selectMaybeCodeModel({
    path: "config.json",
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKey: "key",
      },
    },
    models: {
      reasoner: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
        options: { maxTokens: 100 },
      },
    },
    defaultModel: "reasoner",
  });

  assert.equal(selection.provider, "deepseek");
  assert.equal(selection.adapter, "deepseek-chat");
  assert.equal(selection.model, "deepseek-reasoner");
  assert.deepEqual(selection.options, { maxTokens: 100 });
  assert.deepEqual(selection.limits, {
    contextWindowTokens: 128000,
    maxOutputTokens: 8192,
  });
});

test("attaches configured context limits to the created model", () => {
  const model = createMaybeCodeModel({
    profile: "chat",
    provider: "deepseek",
    adapter: "deepseek-chat",
    model: "deepseek-chat",
    providerConfig: { adapter: "deepseek-chat", apiKey: "test" },
    options: { maxTokens: 2048 },
    limits: { contextWindowTokens: 64000, maxOutputTokens: 8192 },
  });

  assert.deepEqual(model.limits, {
    contextWindowTokens: 64000,
    maxOutputTokens: 2048,
  });
});

test("creates an OpenAI Responses model and preserves native compaction", () => {
  const model = createMaybeCodeModel({
    profile: "gpt",
    provider: "openai",
    adapter: "openai-responses",
    model: "gpt-5.4",
    providerConfig: { adapter: "openai-responses", apiKey: "test" },
    options: {
      reasoningEffort: "high",
      reasoningSummary: "auto",
      serverCompactThreshold: 50_000,
      store: false,
    },
    limits: { contextWindowTokens: 128_000, maxOutputTokens: 8192 },
  });

  assert.deepEqual(model.limits, {
    contextWindowTokens: 128_000,
    maxOutputTokens: 8192,
  });
  assert.equal(model.contextCompactor.name, "openai-responses-compact");
  assert.throws(
    () => createMaybeCodeModel({
      profile: "gpt",
      provider: "openai",
      adapter: "openai-responses",
      model: "gpt-5.4",
      providerConfig: { adapter: "openai-responses", apiKey: "test" },
      options: { store: "yes" },
    }),
    /models\.gpt\.options\.store must be a boolean/,
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
  assert.deepEqual(contextOptions.metadata, { workspace: directory });
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
