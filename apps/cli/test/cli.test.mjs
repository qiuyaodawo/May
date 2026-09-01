import assert from "node:assert/strict";
import test from "node:test";

import { parseMayConfig } from "@may/config";
import { DeepSeekModel, OpenAIResponsesModel } from "@may/providers";
import {
  createConfiguredModel,
  parseCliArgs,
  runCli,
  selectModelConfig,
} from "../dist/index.js";

test("parses the run command and options", () => {
  assert.deepEqual(
    parseCliArgs([
      "run",
      "--config",
      "custom.json",
      "--model",
      "reasoner",
      "hello",
      "May",
    ]),
    {
      type: "run",
      prompt: "hello May",
      configPath: "custom.json",
      model: "reasoner",
    },
  );
  assert.deepEqual(parseCliArgs(["run", "--", "--explain"]), {
    type: "run",
    prompt: "--explain",
  });
  assert.throws(
    () => parseCliArgs(["run", "--config", "--model", "chat", "hello"]),
    /--config requires a value/,
  );
});

test("rejects invalid command arguments before loading config", async () => {
  let loaded = false;
  const stdout = captureOutput();
  const stderr = captureOutput();

  const code = await runCli([
    "run",
    "--model",
    "reasoner",
    "--model",
    "other",
    "hello",
  ], {
    stdout,
    stderr,
    async loadConfig() {
      loaded = true;
      throw new Error("should not load");
    },
  });

  assert.equal(code, 2);
  assert.equal(loaded, false);
  assert.equal(stdout.value, "");
  assert.match(stderr.value, /--model may only be specified once/);
  assert.match(stderr.value, /Usage:/);
});

test("runs with the only configured model profile and streams output", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKey: "test-key",
        baseURL: "https://example.test",
      },
    },
    models: {
      reasoner: { provider: "deepseek", model: "deepseek-reasoner" },
    },
  }, "memory.json");
  const stdout = captureOutput();
  const stderr = captureOutput();
  let loadedWith;
  let selected;
  let request;

  const code = await runCli([
    "run",
    "--config",
    "custom.json",
    "hello",
    "May",
  ], {
    stdout,
    stderr,
    async loadConfig(options) {
      loadedWith = options;
      return config;
    },
    createModel(selection) {
      selected = selection;
      return {
        async *stream(value) {
          request = value;
          yield { type: "reasoning.delta", delta: "Think" };
          yield { type: "text.delta", delta: "Hello" };
          yield { type: "text.delta", delta: " May" };
          yield {
            type: "response.completed",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Hello May" }],
            },
          };
        },
      };
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(loadedWith, { path: "custom.json" });
  assert.deepEqual(selected, {
    profile: "reasoner",
    provider: "deepseek",
    adapter: "deepseek-chat",
    model: "deepseek-reasoner",
    providerConfig: {
      adapter: "deepseek-chat",
      apiKey: "test-key",
      baseURL: "https://example.test",
    },
    options: {},
  });
  assert.equal(request.messages[0].content[0].text, "hello May");
  assert.equal(stdout.value, "Hello May\n");
  assert.equal(stderr.value, "Think\n");
});

test("selects a named model profile and prints a non-streamed final message", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: { adapter: "deepseek-chat", apiKey: "test-key" },
    },
    models: {
      reasoner: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        options: { thinking: "enabled", maxTokens: 2048 },
      },
    },
  });
  const stdout = captureOutput();
  const stderr = captureOutput();
  let selected;

  const code = await runCli(["run", "--model", "reasoner", "hello"], {
    stdout,
    stderr,
    loadConfig: async () => config,
    createModel(selection) {
      selected = selection;
      return completedModel("Final answer");
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(selected.options, {
    thinking: "enabled",
    maxTokens: 2048,
  });
  assert.equal(stdout.value, "Final answer\n");
  assert.equal(stderr.value, "");
});

test("uses defaultModel when no selector is passed", () => {
  const config = parseMayConfig({
    defaultModel: "reasoner",
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      another: { adapter: "openai-responses", apiKey: "unused" },
    },
    models: {
      reasoner: { provider: "deepseek", model: "deepseek-reasoner" },
    },
  });

  const selected = selectModelConfig(config, {}, {
    env: { DEEPSEEK_API_KEY: "env-key" },
  });

  assert.equal(selected.provider, "deepseek");
  assert.equal(selected.model, "deepseek-reasoner");
  assert.equal(selected.providerConfig.apiKey, "env-key");
});

test("reports an ambiguous model selection", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: { adapter: "deepseek-chat", apiKey: "key" },
    },
    models: {
      first: { provider: "deepseek", model: "first" },
      second: { provider: "deepseek", model: "second" },
    },
  }, "memory.json");
  const stderr = captureOutput();

  const code = await runCli(["run", "hello"], {
    stderr,
    stdout: captureOutput(),
    loadConfig: async () => config,
  });

  assert.equal(code, 1);
  assert.match(stderr.value, /Select a model with --model/);
});

test("creates configured provider models and validates CLI-specific options", () => {
  const base = {
    profile: "reasoner",
    provider: "deepseek",
    adapter: "deepseek-chat",
    model: "deepseek-reasoner",
    providerConfig: { adapter: "deepseek-chat", apiKey: "test-key" },
    options: {},
  };

  assert.ok(createConfiguredModel(base) instanceof DeepSeekModel);
  assert.ok(createConfiguredModel({
    profile: "gpt",
    provider: "openai",
    adapter: "openai-responses",
    model: "gpt-5.4",
    providerConfig: { adapter: "openai-responses", apiKey: "test-key" },
    options: {
      reasoningEffort: "high",
      reasoningSummary: "auto",
      serverCompactThreshold: 50_000,
    },
  }) instanceof OpenAIResponsesModel);
  assert.throws(
    () => createConfiguredModel({ ...base, adapter: "another" }),
    /available adapters: deepseek-chat, zhipu-chat, kimi-chat, anthropic-messages, openai-responses, openai-chat-completions/,
  );
  assert.throws(
    () => createConfiguredModel({
      ...base,
      options: { maxTokens: 0 },
    }),
    /maxTokens must be a positive safe integer/,
  );
});

test("returns a failure code when the model fails", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: { adapter: "deepseek-chat", apiKey: "test-key" },
    },
    models: { chat: { provider: "deepseek", model: "model" } },
  });
  const stderr = captureOutput();

  const code = await runCli(["run", "hello"], {
    stdout: captureOutput(),
    stderr,
    loadConfig: async () => config,
    createModel() {
      return {
        async *stream() {
          throw new Error("network unavailable");
        },
      };
    },
  });

  assert.equal(code, 1);
  assert.equal(stderr.value, "Error: network unavailable\n");
});

test("returns exit code 130 when cancelled", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: { adapter: "deepseek-chat", apiKey: "test-key" },
    },
    models: { chat: { provider: "deepseek", model: "model" } },
  });
  const controller = new AbortController();
  controller.abort("Interrupted");
  const stderr = captureOutput();

  const code = await runCli(["run", "hello"], {
    stdout: captureOutput(),
    stderr,
    signal: controller.signal,
    loadConfig: async () => config,
    createModel: () => completedModel("unreachable"),
  });

  assert.equal(code, 130);
  assert.equal(stderr.value, "Cancelled\n");
});

function completedModel(text) {
  return {
    async *stream() {
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      };
    },
  };
}

function captureOutput() {
  return {
    value: "",
    write(text) {
      this.value += text;
    },
  };
}
