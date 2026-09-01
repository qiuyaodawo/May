import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext } from "@may/core";

import {
  createMaybeCodeModel,
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
    },
  );
  assert.equal(parseMaybeCodeArgs([]).autoResume, false);
  assert.equal(parseMaybeCodeArgs(["--continue"]).autoResume, true);
  assert.throws(
    () => parseMaybeCodeArgs(["--continue", "--resume", "abc"]),
    /cannot be used together/,
  );
});

test("selects the default model profile", () => {
  const selection = selectMaybeCodeModel({
    path: "config.json",
    providers: {
      deepseek: {
        apiKey: "key",
        contextWindowTokens: 128000,
        maxOutputTokens: 8192,
      },
    },
    models: {
      reasoner: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        options: { maxTokens: 100 },
      },
    },
    defaultModel: "reasoner",
  });

  assert.equal(selection.provider, "deepseek");
  assert.equal(selection.model, "deepseek-reasoner");
  assert.deepEqual(selection.options, { maxTokens: 100 });
  assert.deepEqual(selection.limits, {
    contextWindowTokens: 128000,
    maxOutputTokens: 8192,
  });
});

test("attaches configured context limits to the created model", () => {
  const model = createMaybeCodeModel({
    provider: "deepseek",
    model: "deepseek-chat",
    providerConfig: { apiKey: "test" },
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
    provider: "openai",
    model: "gpt-5.4",
    providerConfig: { apiKey: "test" },
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
      provider: "openai",
      model: "gpt-5.4",
      providerConfig: { apiKey: "test" },
      options: { store: "yes" },
    }),
    /providers\.openai\.store must be a boolean/,
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
              apiKey: "test",
              model: "deepseek-chat",
              contextWindowTokens: 64000,
              maxOutputTokens: 4096,
            },
          },
          models: {},
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
    provider: "deepseek",
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
          providers: { deepseek: { apiKey: "test", model: "deepseek-chat" } },
          models: {},
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
    await assert.rejects(
      openConfiguredMaybeCode(
        { workspace: "E:codeept" },
        {
          async loadConfig() {
            throw new Error("config should not be loaded");
          },
        },
      ),
      /Git Bash removes unquoted backslashes.*E:\/code\/project/u,
    );
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
              apiKey: "test",
              model: "gpt-5.4",
              contextWindowTokens: 128_000,
              maxOutputTokens: 8192,
            },
          },
          models: {},
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
