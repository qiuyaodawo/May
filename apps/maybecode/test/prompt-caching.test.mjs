import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltinProviderModel } from "@sortedyuan/providers";
import { selectMaybeCodeModel } from "../dist/model.js";

test("MaybeCode Anthropic caching defaults respect provider and model configuration", () => {
  for (const [providerCaching, modelCaching, expected] of [
    [undefined, undefined, { ttl: "5m", cacheInstructions: true }],
    [false, undefined, false],
    [{ ttl: "1h", cacheInstructions: true }, false, false],
    [false, { ttl: "1h" }, { ttl: "1h" }],
    [{ ttl: "1h", cacheInstructions: true }, {}, {}],
  ]) {
    const config = {
      path: "may.config.json",
      providers: {
        anthropic: {
          adapter: "anthropic-messages",
          apiKey: "offline-body-inspection",
          options: providerCaching === undefined ? {} : { promptCaching: providerCaching },
        },
      },
      models: {
        chat: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          options: modelCaching === undefined ? {} : { promptCaching: modelCaching },
        },
      },
      defaultModel: "chat",
    };
    const selection = selectMaybeCodeModel(config);
    assert.deepEqual(selection.options.promptCaching, expected);
    const body = createBuiltinProviderModel(selection).model.createRequest({
      messages: [
        { role: "system", content: [{ type: "text", text: "Instructions" }] },
        { role: "user", content: [{ type: "text", text: "Hello" }] },
      ],
      tools: [],
    });
    assert.deepEqual(
      body.cache_control,
      expected === false ? undefined : { type: "ephemeral", ttl: expected.ttl ?? "5m" },
    );
    assert.equal(Array.isArray(body.system), expected !== false && expected.cacheInstructions === true);
  }
});

test("MaybeCode applies caching defaults only to the Anthropic adapter", () => {
  const selection = selectMaybeCodeModel({
    path: "may.config.json",
    providers: { openai: { adapter: "openai-responses", apiKey: "offline-body-inspection" } },
    models: { chat: { provider: "openai", model: "gpt-5" } },
    defaultModel: "chat",
  });
  assert.equal(selection.options.promptCaching, undefined);
});
