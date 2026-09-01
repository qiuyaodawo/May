import assert from "node:assert/strict";
import test from "node:test";

import { parseMayConfig } from "@may/config";
import {
  AnthropicModel,
  createBuiltinProviderModel,
  createBuiltinProviderAdapterRegistry,
  createModelCapabilityResolver,
  DeepSeekModel,
  KimiModel,
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  ProviderAdapterRegistry,
  ProviderAdapterRegistryError,
  ProviderConfigurationError,
  RetryingModel,
  selectProviderModel,
  withModelRetry,
  ZhipuModel,
} from "../dist/index.js";

const request = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

function apiError(status, message = `status ${status}`) {
  return Object.assign(new Error(message), { status });
}

test("retries transient model errors and exposes attempt events", async () => {
  let attempts = 0;
  const delays = [];
  const wrapped = new RetryingModel({
    limits: { contextWindowTokens: 1000 },
    contextCompactor: { name: "native", async compact() { return { messages: [] }; } },
    async *stream() {
      attempts += 1;
      if (attempts < 3) throw apiError(429, "busy");
      yield { type: "text.delta", delta: "ok" };
      yield { type: "response.completed", message: completedMessage("ok") };
    },
  }, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
    jitterRatio: 0,
    sleep: async (delay) => delays.push(delay),
  });

  const events = await collect(wrapped.stream(request, {
    signal: new AbortController().signal,
  }));

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.deepEqual(events.map((event) => event.type), [
    "retrying",
    "retrying",
    "text.delta",
    "response.completed",
  ]);
  assert.deepEqual(events.slice(0, 2).map((event) => ({
    attempt: event.attempt,
    maxAttempts: event.maxAttempts,
    delayMs: event.delayMs,
    message: event.error.message,
  })), [
    { attempt: 2, maxAttempts: 3, delayMs: 10, message: "busy" },
    { attempt: 3, maxAttempts: 3, delayMs: 20, message: "busy" },
  ]);
  assert.deepEqual(wrapped.limits, { contextWindowTokens: 1000 });
  assert.equal(wrapped.contextCompactor.name, "native");
});

test("does not retry permanent failures or failures after completion", async () => {
  let permanentAttempts = 0;
  const permanent = withModelRetry({
    async *stream() {
      permanentAttempts += 1;
      throw apiError(401, "invalid key");
    },
  }, { baseDelayMs: 0 });
  await assert.rejects(
    collect(permanent.stream(request, { signal: new AbortController().signal })),
    /invalid key/,
  );
  assert.equal(permanentAttempts, 1);

  let completedAttempts = 0;
  const completedThenFailed = withModelRetry({
    async *stream() {
      completedAttempts += 1;
      yield { type: "response.completed", message: completedMessage("done") };
      throw apiError(500, "late failure");
    },
  }, { baseDelayMs: 0 });
  await assert.rejects(
    collect(completedThenFailed.stream(request, {
      signal: new AbortController().signal,
    })),
    /late failure/,
  );
  assert.equal(completedAttempts, 1);
});

test("uses retryAfterMs and cancels an active backoff", async () => {
  const delays = [];
  const hinted = withModelRetry({
    async *stream() {
      const error = apiError(503);
      error.retryAfterMs = 1234;
      throw error;
    },
  }, {
    maxAttempts: 2,
    maxDelayMs: 2000,
    sleep: async (delay) => delays.push(delay),
  });
  await assert.rejects(
    collect(hinted.stream(request, { signal: new AbortController().signal })),
    /status 503/,
  );
  assert.deepEqual(delays, [1234]);

  const controller = new AbortController();
  const cancelling = withModelRetry({
    async *stream() {
      throw apiError(500);
    },
  }, { baseDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 });
  const iterator = cancelling.stream(request, { signal: controller.signal })
    [Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, "retrying");
  controller.abort("cancel retry");
  await assert.rejects(iterator.next(), (error) =>
    error.name === "AbortError" && error.message === "cancel retry"
  );
});

test("registers custom adapters without using global state", () => {
  const firstModel = completedModel("first");
  const secondModel = completedModel("second");
  const first = new ProviderAdapterRegistry().register("custom", {
    create(selection) {
      assert.equal(selection.model, "custom-model");
      return firstModel;
    },
  });
  const second = new ProviderAdapterRegistry().register("custom", {
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
    () => first.create({ ...selection, adapter: "missing" }),
    /available adapters: custom/,
  );
  assert.throws(() => new ProviderAdapterRegistry().register("", {
    create: () => firstModel,
  }), /adapter name must be a non-empty string/);
});

test("selects provider models once for all consuming applications", () => {
  const config = parseMayConfig({
    defaultModel: "reasoner",
    providers: {
      openai: {
        adapter: "openai-responses",
        apiKeyEnv: "OPENAI_API_KEY",
      },
    },
    models: {
      reasoner: {
        provider: "openai",
        model: "gpt-test",
        contextWindowTokens: 128_000,
        maxOutputTokens: 4096,
        options: { reasoningEffort: "high" },
      },
    },
  }, "memory.json");

  const selected = selectProviderModel(config, {}, {
    env: { OPENAI_API_KEY: "secret" },
  });

  assert.equal(selected.provider, "openai");
  assert.equal(selected.adapter, "openai-responses");
  assert.equal(selected.profile, "reasoner");
  assert.equal(selected.model, "gpt-test");
  assert.equal(selected.providerConfig.apiKey, "secret");
  assert.deepEqual(selected.options, { reasoningEffort: "high" });
  assert.deepEqual(selected.limits, {
    contextWindowTokens: 128_000,
    maxOutputTokens: 4096,
  });
});

test("resolves model capabilities by explicit, provider, builtin, then unknown priority", async () => {
  let requests = 0;
  const resolver = createModelCapabilityResolver({
    async fetch(url, init) {
      requests += 1;
      assert.equal(url, "https://cpa.test/v1/models?client_version=may");
      assert.equal(init.headers.Authorization, "Bearer test-key");
      return Response.json({
        models: [{
          slug: "gpt-5.6-luna",
          default_reasoning_level: "medium",
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
            { effort: "max" },
          ],
        }],
      });
    },
  });
  const cpa = modelSelection(
    "openai-responses",
    "gpt-5.6-luna",
    { baseURL: "https://cpa.test/v1" },
  );

  assert.deepEqual((await resolver.resolve(cpa)).reasoningEffort, {
    status: "known",
    source: "provider",
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
  });
  assert.deepEqual((await resolver.resolve({
    ...cpa,
    capabilities: {
      reasoning: { efforts: ["high"], defaultEffort: "high" },
    },
  })).reasoningEffort, {
    status: "known",
    source: "user",
    efforts: ["high"],
    defaultEffort: "high",
  });
  assert.equal(requests, 1);

  const offline = createModelCapabilityResolver({ discoveries: [] });
  assert.deepEqual((await offline.resolve(
    modelSelection("deepseek-chat", "deepseek-v4-pro"),
  )).reasoningEffort, {
    status: "known",
    source: "builtin",
    efforts: ["low", "high", "max"],
    defaultEffort: "high",
  });
  assert.deepEqual((await offline.resolve(
    modelSelection("deepseek-chat", "unlisted-model"),
  )).reasoningEffort, { status: "unknown", source: "unknown" });
});

test("provides every built-in adapter", () => {
  assert.ok(createBuiltinProviderModel(
    modelSelection("deepseek-chat", "deepseek-chat"),
  ) instanceof DeepSeekModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("zhipu-chat", "glm-5"),
  ) instanceof ZhipuModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("kimi-chat", "kimi-k3"),
  ) instanceof KimiModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("anthropic-messages", "claude-test"),
  ) instanceof AnthropicModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("openai-responses", "gpt-test"),
  ) instanceof OpenAIResponsesModel);
  assert.ok(createBuiltinProviderModel(
    modelSelection("openai-chat-completions", "gpt-test"),
  ) instanceof OpenAIChatCompletionsModel);

  const names = createBuiltinProviderAdapterRegistry().names();
  assert.deepEqual(names, [
    "deepseek-chat",
    "zhipu-chat",
    "kimi-chat",
    "anthropic-messages",
    "openai-responses",
    "openai-chat-completions",
  ]);
});

test("maps provider-specific configuration into each adapter request", async () => {
  const requests = [];
  const registry = createBuiltinProviderAdapterRegistry({
    async fetch(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return new Response("expected test failure", { status: 500 });
    },
  });

  await sendAndReject(registry.create(modelSelection(
    "deepseek-chat",
    "deepseek-test",
    { baseURL: "https://deepseek.test" },
    { thinking: "disabled", reasoningEffort: "high", maxTokens: 2000 },
  )));
  assert.equal(requests[0].url, "https://deepseek.test/chat/completions");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.equal(requests[0].body.max_tokens, 2000);

  await sendAndReject(registry.create(modelSelection(
    "zhipu-chat",
    "glm-test",
    { baseURL: "https://glm.test" },
    {
      thinking: "enabled",
      clearThinking: true,
      reasoningEffort: "max",
      maxTokens: 3000,
    },
  )));
  assert.equal(requests[1].url, "https://glm.test/chat/completions");
  assert.deepEqual(requests[1].body.thinking, {
    type: "enabled",
    clear_thinking: true,
  });
  assert.equal(requests[1].body.reasoning_effort, "max");

  await sendAndReject(registry.create(modelSelection(
    "kimi-chat",
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
    "anthropic-messages",
    "claude-test",
    { baseURL: "https://anthropic.test" },
    {
      apiVersion: "test-version",
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
    "openai-responses",
    "gpt-test",
    {
      baseURL: "https://openai.test/v1",
    },
    {
      reasoningSummary: "auto",
      serverCompactThreshold: 50_000,
      store: false,
      reasoningEffort: "high",
      maxOutputTokens: 5000,
    },
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

  await sendAndReject(registry.create(modelSelection(
    "openai-chat-completions",
    "proxy-model",
    { baseURL: "https://proxy.test/v1" },
    { reasoningEffort: "ultra", maxOutputTokens: 6000, store: false },
  )));
  assert.equal(requests[5].url, "https://proxy.test/v1/chat/completions");
  assert.equal(requests[5].body.model, "proxy-model");
  assert.equal(requests[5].body.reasoning_effort, "ultra");
  assert.equal(requests[5].body.max_completion_tokens, 6000);
  assert.equal(requests[5].body.store, false);
});

test("preserves model limits and provider-native capabilities", () => {
  const model = createBuiltinProviderModel({
    ...modelSelection("openai-responses", "gpt-test"),
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
    ProviderAdapterRegistryError,
  );
  assert.throws(
    () => createBuiltinProviderModel(modelSelection(
      "kimi-chat",
      "kimi-test",
      {},
      { thinking: { type: "sometimes" } },
    )),
    /models\.test-profile\.options\.thinking\.type must be one of/,
  );
  assert.throws(
    () => createBuiltinProviderModel(modelSelection(
      "anthropic-messages",
      "claude-test",
      {},
      { thinking: { type: "enabled" } },
    )),
    /budgetTokens is required/,
  );
  assert.throws(
    () => createBuiltinProviderModel({
      ...modelSelection("openai-responses", "gpt-test"),
      providerConfig: { adapter: "openai-responses" },
    }),
    /providers\.test-provider\.apiKey must be a non-empty string/,
  );
});

function modelSelection(
  adapter,
  model,
  providerConfig = {},
  options = {},
) {
  return {
    profile: "test-profile",
    provider: "test-provider",
    adapter,
    model,
    providerConfig: { adapter, apiKey: "test-key", ...providerConfig },
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

function completedMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}
