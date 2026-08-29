import assert from "node:assert/strict";
import test from "node:test";

import { parseMayConfig } from "@may/config";
import {
  AnthropicModel,
  createBuiltinProviderModel,
  createBuiltinProviderRegistry,
  DeepSeekModel,
  KimiModel,
  OpenAIResponsesModel,
  ProviderConfigurationError,
  ProviderRegistry,
  ProviderRegistryError,
  selectProviderModel,
  ZhipuModel,
} from "../dist/index.js";

const request = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

test("registers custom providers without using global state", () => {
  const firstModel = completedModel("first");
  const secondModel = completedModel("second");
  const first = new ProviderRegistry().register("custom", {
    create(selection) {
      assert.equal(selection.model, "custom-model");
      return firstModel;
    },
  });
  const second = new ProviderRegistry().register("custom", {
    create: () => secondModel,
  });
  const selection = modelSelection("custom", "custom-model");

  assert.equal(first.create(selection), firstModel);
  assert.equal(second.create(selection), secondModel);
  assert.deepEqual(first.names(), ["custom"]);
  assert.equal(first.has("custom"), true);
  assert.equal(first.has("missing"), false);
  assert.throws(
    () => first.register("custom", { create: () => firstModel }),
    /already registered/,
  );
  assert.throws(
    () => first.create({ ...selection, provider: "missing" }),
    /available providers: custom/,
  );
  assert.throws(() => new ProviderRegistry().register("", {
    create: () => firstModel,
  }), /provider name must be a non-empty string/);
});

test("selects provider models once for all consuming applications", () => {
  const config = parseMayConfig({
    defaultModel: "reasoner",
    providers: {
      openai: {
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindowTokens: 128_000,
        maxOutputTokens: 8192,
      },
    },
    models: {
      reasoner: {
        provider: "openai",
        model: "gpt-test",
        maxOutputTokens: 4096,
        options: { reasoningEffort: "high" },
      },
    },
  }, "memory.json");

  const selected = selectProviderModel(config, {}, {
    env: { OPENAI_API_KEY: "secret" },
  });

  assert.equal(selected.provider, "openai");
  assert.equal(selected.model, "gpt-test");
  assert.equal(selected.providerConfig.apiKey, "secret");
  assert.deepEqual(selected.options, { reasoningEffort: "high" });
  assert.deepEqual(selected.limits, {
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
  });
  assert.throws(
    () => selectProviderModel(config, { provider: "openai", model: "reasoner" }),
    ProviderConfigurationError,
  );
});

test("provides every built-in adapter and a GLM alias", () => {
  assert.ok(createBuiltinProviderModel(
    modelSelection("deepseek", "deepseek-chat"),
  ) instanceof DeepSeekModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("zhipu", "glm-5"),
  ) instanceof ZhipuModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("glm", "glm-5"),
  ) instanceof ZhipuModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("kimi", "kimi-k3"),
  ) instanceof KimiModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("anthropic", "claude-test"),
  ) instanceof AnthropicModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("openai", "gpt-test"),
  ) instanceof OpenAIResponsesModel);

  const names = createBuiltinProviderRegistry().names();
  assert.deepEqual(names, [
    "deepseek",
    "zhipu",
    "glm",
    "kimi",
    "anthropic",
    "openai",
  ]);
});

test("maps provider-specific configuration into each adapter request", async () => {
  const requests = [];
  const registry = createBuiltinProviderRegistry({
    async fetch(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response("expected test failure", { status: 500 });
    },
  });

  await sendAndReject(registry.create(modelSelection(
    "deepseek",
    "deepseek-test",
    { baseURL: "https://deepseek.test", thinking: "disabled" },
    { reasoningEffort: "high", maxTokens: 2000 },
  )));
  assert.equal(requests[0].url, "https://deepseek.test/chat/completions");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.equal(requests[0].body.max_tokens, 2000);

  await sendAndReject(registry.create(modelSelection(
    "glm",
    "glm-test",
    { baseURL: "https://glm.test", clearThinking: true },
    { thinking: "enabled", reasoningEffort: "max", maxTokens: 3000 },
  )));
  assert.equal(requests[1].url, "https://glm.test/chat/completions");
  assert.deepEqual(requests[1].body.thinking, {
    type: "enabled",
    clear_thinking: true,
  });
  assert.equal(requests[1].body.reasoning_effort, "max");

  await sendAndReject(registry.create(modelSelection(
    "kimi",
    "kimi-test",
    { baseURL: "https://kimi.test" },
    {
      thinking: { type: "enabled", keep: "all" },
      reasoningEffort: "high",
      maxTokens: 4000,
    },
  )));
  assert.equal(requests[2].url, "https://kimi.test/chat/completions");
  assert.deepEqual(requests[2].body.thinking, {
    type: "enabled",
    keep: "all",
  });
  assert.equal(requests[2].body.max_completion_tokens, 4000);

  await sendAndReject(registry.create(modelSelection(
    "anthropic",
    "claude-test",
    { baseURL: "https://anthropic.test", apiVersion: "test-version" },
    {
      thinking: { type: "enabled", budgetTokens: 1024 },
      reasoningEffort: "high",
      maxTokens: 4096,
    },
  )));
  assert.equal(requests[3].url, "https://anthropic.test/v1/messages");
  assert.equal(requests[3].init.headers["anthropic-version"], "test-version");
  assert.deepEqual(requests[3].body.thinking, {
    type: "enabled",
    budget_tokens: 1024,
  });
  assert.deepEqual(requests[3].body.output_config, { effort: "high" });

  await sendAndReject(registry.create(modelSelection(
    "openai",
    "gpt-test",
    {
      baseURL: "https://openai.test/v1",
      reasoningSummary: "auto",
      serverCompactThreshold: 50_000,
      store: false,
    },
    { reasoningEffort: "high", maxOutputTokens: 5000 },
  )));
  assert.equal(requests[4].url, "https://openai.test/v1/responses");
  assert.deepEqual(requests[4].body.reasoning, {
    effort: "high",
    generate_summary: "auto",
  });
  assert.equal(requests[4].body.max_output_tokens, 5000);
  assert.deepEqual(requests[4].body.context_management, [{
    type: "compaction",
    compact_threshold: 50_000,
  }]);
});

test("preserves model limits and provider-native capabilities", () => {
  const model = createBuiltinProviderModel({
    ...modelSelection("openai", "gpt-test"),
    limits: { contextWindowTokens: 100_000, maxOutputTokens: 8000 },
  });

  assert.deepEqual(model.limits, {
    contextWindowTokens: 100_000,
    maxOutputTokens: 8000,
  });
  assert.equal(model.contextCompactor.name, "openai-responses-compact");
});

test("reports registry and provider configuration errors", () => {
  assert.throws(
    () => createBuiltinProviderModel(modelSelection("missing", "model")),
    ProviderRegistryError,
  );
  assert.throws(
    () => createBuiltinProviderModel(modelSelection(
      "kimi",
      "kimi-test",
      {},
      { thinking: { type: "sometimes" } },
    )),
    /providers\.kimi\.thinking\.type must be one of/,
  );
  assert.throws(
    () => createBuiltinProviderModel(modelSelection(
      "anthropic",
      "claude-test",
      {},
      { thinking: { type: "enabled" } },
    )),
    /budgetTokens is required/,
  );
  assert.throws(
    () => createBuiltinProviderModel({
      ...modelSelection("openai", "gpt-test"),
      providerConfig: {},
    }),
    /providers\.openai\.apiKey must be a non-empty string/,
  );
});

function modelSelection(
  provider,
  model,
  providerConfig = {},
  options = {},
) {
  return {
    provider,
    model,
    providerConfig: { apiKey: "test-key", ...providerConfig },
    options,
  };
}

async function sendAndReject(model) {
  await assert.rejects(
    collect(model.stream(request, { signal: new AbortController().signal })),
    /expected test failure/,
  );
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

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
