import assert from "node:assert/strict";
import test from "node:test";

import { parseMayConfig } from "@may/config";
import { DeepSeekModel } from "@may/provider-deepseek";
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
      "--provider",
      "deepseek",
      "hello",
      "May",
    ]),
    {
      type: "run",
      prompt: "hello May",
      configPath: "custom.json",
      provider: "deepseek",
    },
  );
  assert.deepEqual(parseCliArgs(["run", "--", "--explain"]), {
    type: "run",
    prompt: "--explain",
  });
});

test("rejects invalid command arguments before loading config", async () => {
  let loaded = false;
  const stdout = captureOutput();
  const stderr = captureOutput();

  const code = await runCli([
    "run",
    "--provider",
    "deepseek",
    "--model",
    "reasoner",
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
  assert.match(stderr.value, /--provider and --model cannot be used together/);
  assert.match(stderr.value, /Usage:/);
});

test("runs with the only configured provider and streams output", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: {
        apiKey: "test-key",
        baseURL: "https://example.test",
        model: "deepseek-reasoner",
      },
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
    provider: "deepseek",
    model: "deepseek-reasoner",
    providerConfig: {
      apiKey: "test-key",
      baseURL: "https://example.test",
      model: "deepseek-reasoner",
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
      deepseek: { apiKey: "test-key" },
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
      deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY" },
      another: { apiKey: "unused", model: "unused" },
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

test("reports an ambiguous provider selection", async () => {
  const config = parseMayConfig({
    providers: {
      deepseek: { apiKey: "key", model: "model" },
      another: { apiKey: "key", model: "model" },
    },
  }, "memory.json");
  const stderr = captureOutput();

  const code = await runCli(["run", "hello"], {
    stderr,
    stdout: captureOutput(),
    loadConfig: async () => config,
  });

  assert.equal(code, 1);
  assert.match(stderr.value, /Select a provider with --provider/);
});

test("creates DeepSeek models and validates CLI-specific options", () => {
  const base = {
    provider: "deepseek",
    model: "deepseek-reasoner",
    providerConfig: { apiKey: "test-key" },
    options: {},
  };

  assert.ok(createConfiguredModel(base) instanceof DeepSeekModel);
  assert.throws(
    () => createConfiguredModel({ ...base, provider: "another" }),
    /currently supports deepseek/,
  );
  assert.throws(
    () => createConfiguredModel({
      ...base,
      options: { reasoningEffort: "extreme" },
    }),
    /reasoningEffort must be one of/,
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
      deepseek: { apiKey: "test-key", model: "model" },
    },
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
      deepseek: { apiKey: "test-key", model: "model" },
    },
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
