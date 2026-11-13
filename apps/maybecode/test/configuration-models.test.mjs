import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { assistantMessage, temporaryDirectory } from "./fixtures/application.mjs";

import { InMemoryContextFactory } from "@sortedyuan/may/context";

import { openConfiguredMaybeCode } from "../dist/index.js";
import { createMaybeCodeSlashCommandSuggester } from "../dist/slash-command-suggestions.js";
import { executeMaybeCodeSlashCommand } from "../dist/slash-command-execution.js";
import { resolveMaybeCodeRetry } from "../dist/configured-resolvers.js";

test("switches configured model profiles by prefix without changing sessions", async (t) => {
  const directory = await temporaryDirectory(t);
  const created = [];
  const persistedDefaults = [];
  const app = await openConfiguredMaybeCode(
    { git: false, workspace: directory, dataDirectory: join(directory, "data"), autoResume: false },
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
          apps: { maybecode: { retry: false, requestRecording: "off" } },
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
  await (
    await app.submit({ input: "before" })
  ).result;
  const suggest = createMaybeCodeSlashCommandSuggester(app);
  assert.deepEqual(
    (await suggest("/model cliproxy-")).map((item) => item.label),
    ["cliproxy-low", "cliproxy-high"],
  );

  assert.deepEqual(
    (await suggest("/model clip ")).map((item) => item.label),
    ["--default"],
  );
  const switched = await executeMaybeCodeSlashCommand("/model clip --default", app);
  assert.equal(switched.type, "model.switched");
  assert.equal(switched.profile, "cliproxy-low");
  assert.equal(app.sessionId, sessionId);
  assert.equal(app.application.modelInfo.profile, "cliproxy-low");
  assert.deepEqual(created, ["cliproxy-high", "cliproxy-low"]);
  assert.deepEqual(persistedDefaults, ["cliproxy-low"]);
  assert.deepEqual(
    (await app.listModels()).filter((model) => model.isDefault).map((model) => model.name),
    ["cliproxy-low"],
  );
  assert.equal((await (await app.submit({ input: "after" })).result).message.content[0].text, "cliproxy-low");
  assert.equal((await executeMaybeCodeSlashCommand("/model", app)).type, "model.selection.requested");
  await app.close();
});

test("switches supported reasoning effort without duplicating model profiles", async (t) => {
  const directory = await temporaryDirectory(t);
  const createdEfforts = [];
  const app = await openConfiguredMaybeCode(
    { git: false, workspace: directory, dataDirectory: join(directory, "data"), autoResume: false },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            deepseek: { adapter: "deepseek-chat", apiKey: "test", baseURL: "http://127.0.0.1:1" },
          },
          models: {
            reasoner: {
              provider: "deepseek",
              model: "deepseek-v4-pro",
            },
          },
          defaultModel: "reasoner",
          apps: { maybecode: { retry: false, requestRecording: "off" } },
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

  assert.deepEqual(opened.strategyNames, ["prune-old-tool-results", "summary-tail"]);
  await opened.app.close();
});

test("selects independent automatic compaction modes", async (t) => {
  for (const [mode, expected] of [
    ["prune-summary", ["prune-old-tool-results", "summary-tail"]],
    ["history-reference", ["history-reference"]],
    ["provider-native", ["openai-responses-compact"]],
  ]) {
    const opened = await openWithCapturedOpenAIContext(t, {
      maybecode: { autoCompaction: { mode } },
    });
    assert.deepEqual(opened.strategyNames, expected);
    await opened.app.close();
  }
});

test("validates automatic compaction mode", async (t) => {
  for (const mode of ["unknown", true, null]) {
    await assert.rejects(
      openWithCapturedOpenAIContext(t, { maybecode: { autoCompaction: { mode } } }),
      /apps\.maybecode\.autoCompaction\.mode must be equal to one of the allowed values/,
    );
  }
});

test("validates automatic compaction configuration shape", async (t) => {
  await assert.rejects(
    openWithCapturedOpenAIContext(t, {
      maybecode: { autoCompaction: true },
    }),
    /apps\.maybecode\.autoCompaction must be object/,
  );
});

test("resolves and validates MaybeCode model retry configuration", () => {
  const base = { path: "config.json", providers: {}, models: {} };
  assert.deepEqual(resolveMaybeCodeRetry(base), {});
  assert.equal(
    resolveMaybeCodeRetry({
      ...base,
      apps: { maybecode: { retry: false } },
    }),
    false,
  );
  assert.deepEqual(
    resolveMaybeCodeRetry({
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
    }),
    {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 2000,
      jitterRatio: 0.1,
    },
  );
  assert.throws(
    () =>
      resolveMaybeCodeRetry({
        ...base,
        apps: { maybecode: { retry: { maxAttempts: 0 } } },
      }),
    /apps\.maybecode\.retry\.maxAttempts must be >= 1/u,
  );
  assert.throws(
    () =>
      resolveMaybeCodeRetry({
        ...base,
        apps: { maybecode: { retry: { baseDelayMs: 9000 } } },
      }),
    /baseDelayMs cannot exceed maxDelayMs/u,
  );
});

test("configured MaybeCode automatically retries transient model failures", async (t) => {
  const directory = await temporaryDirectory(t);
  let attempts = 0;
  const app = await openConfiguredMaybeCode(
    { git: false, workspace: directory, dataDirectory: join(directory, "data"), autoResume: false, subagents: false },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            deepseek: { adapter: "deepseek-chat", apiKey: "test", baseURL: "http://127.0.0.1:1" },
          },
          models: {
            chat: { provider: "deepseek", model: "deepseek-chat" },
          },
          defaultModel: "chat",
          apps: {
            maybecode: {
              requestRecording: "off",
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

async function openWithCapturedOpenAIContext(t, apps) {
  const directory = await temporaryDirectory(t);
  let contextOptions;
  const app = await openConfiguredMaybeCode(
    {
      git: false,
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
      contextFactory: {
        create(options) {
          contextOptions = options;
          return new InMemoryContextFactory().create(options);
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
    strategyNames: contextOptions.autoCompactionStrategies.map((strategy) => strategy.name),
  };
}
