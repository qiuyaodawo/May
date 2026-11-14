import assert from "node:assert/strict";
import test from "node:test";
import { ANTHROPIC_MODEL_STATE_TYPE, AnthropicModel } from "../../dist/anthropic/index.js";
import { createBuiltinProviderModel } from "../../dist/index.js";

async function sentBody(create, request) {
  const bodies = [];
  const model = create(async (url, init) => {
    if (!url.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
    bodies.push(JSON.parse(init.body));
    return Response.json(
      { type: "error", error: { type: "api_error", message: "request body captured" } },
      { status: 500 },
    );
  });
  await assert.rejects(async () => {
    for await (const event of model.stream(request, { signal: new AbortController().signal })) void event;
  }, /request body captured/);
  assert.equal(bodies.length, 1);
  return bodies[0];
}

function anthropic(options) {
  return (fetch) =>
    new AnthropicModel({ apiKey: "offline-body-inspection", model: "claude-sonnet-4-6", fetch, ...options });
}

test("Anthropic request caching uses matching automatic and instruction TTLs", async () => {
  const request = {
    messages: [
      { role: "system", content: [{ type: "text", text: "Instructions" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ],
    tools: [
      { name: "add", description: "Add", inputSchema: { type: "object" } },
      { name: "subtract", description: "Subtract", inputSchema: { type: "object" } },
    ],
  };
  for (const promptCaching of [
    undefined,
    false,
    {},
    { cacheInstructions: false },
    { ttl: "1h" },
    { ttl: "1h", cacheInstructions: true },
    { ttl: "5m", cacheInstructions: true },
  ]) {
    const body = await sentBody(anthropic(promptCaching === undefined ? {} : { promptCaching }), request);
    if (promptCaching === undefined || promptCaching === false) {
      assert.equal(body.cache_control, undefined);
      assert.equal(body.tools[0].cache_control, undefined);
      assert.equal(body.system, "Instructions");
    } else {
      assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: promptCaching.ttl ?? "5m" });
      if (promptCaching.cacheInstructions) {
        assert.deepEqual(body.system.at(-1).cache_control, body.cache_control);
        assert.deepEqual(body.tools.at(-1).cache_control, body.cache_control);
        assert.equal(body.tools[0].cache_control, undefined);
      } else {
        assert.equal(body.system, "Instructions");
        assert.ok(body.tools.every((tool) => tool.cache_control === undefined));
      }
    }
  }
});

test("Anthropic provider defaults and explicit model overrides construct matching requests", async () => {
  for (const [providerCaching, modelCaching, expected] of [
    [{ ttl: "1h", cacheInstructions: true }, undefined, "1h"],
    [{ ttl: "1h", cacheInstructions: true }, false, undefined],
    [false, { ttl: "5m" }, "5m"],
    [{ ttl: "1h" }, {}, "5m"],
    [undefined, undefined, undefined],
  ]) {
    const body = await sentBody(
      (fetch) =>
        createBuiltinProviderModel(
          {
            profile: "offline",
            provider: "anthropic",
            adapter: "anthropic-messages",
            model: "claude-sonnet-4-6",
            providerConfig: { apiKey: "offline-body-inspection", options: { promptCaching: providerCaching } },
            options: modelCaching === undefined ? {} : { promptCaching: modelCaching },
          },
          { fetch },
        ),
      { messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], tools: [] },
    );
    assert.equal(body.cache_control?.ttl, expected);
  }
});

test("automatic caching preserves native thinking and tool continuation content", async () => {
  const nativeContent = [
    { type: "thinking", thinking: "Calculate the sum", signature: "retained-signature" },
    { type: "redacted_thinking", data: "retained-redacted-data" },
    { type: "tool_use", id: "call-add", name: "add", input: { a: 1, b: 2 } },
  ];
  const messages = [
    { role: "system", content: [{ type: "text", text: "First instructions" }] },
    { role: "system", content: [{ type: "text", text: "Second instructions" }] },
    { role: "user", content: [{ type: "text", text: "Add 1 and 2" }] },
    {
      role: "assistant",
      content: [],
      toolCalls: [{ id: "call-add", name: "add", input: { a: 1, b: 2 } }],
      modelState: { type: ANTHROPIC_MODEL_STATE_TYPE, data: { messageId: "message-add", content: nativeContent } },
    },
    { role: "tool", toolCallId: "call-add", content: [{ type: "text", text: "3" }] },
  ];
  const snapshot = structuredClone(messages);
  const body = await sentBody(
    anthropic({ promptCaching: { ttl: "1h", cacheInstructions: true }, thinking: { type: "adaptive" } }),
    { messages, tools: [] },
  );
  assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: "1h" });
  assert.deepEqual(body.system, [
    { type: "text", text: "First instructions\nSecond instructions", cache_control: body.cache_control },
  ]);
  assert.deepEqual(body.messages[1].content, nativeContent);
  assert.deepEqual(body.messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "call-add", content: "3" }],
  });
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.tools, undefined);
  assert.deepEqual(messages, snapshot);
});

test("automatic caching supports requests without system messages or tools", async () => {
  const body = await sentBody(anthropic({ promptCaching: { cacheInstructions: true } }), {
    messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    tools: [],
  });
  assert.deepEqual(body.cache_control, { type: "ephemeral", ttl: "5m" });
  assert.equal(body.system, undefined);
  assert.equal(body.tools, undefined);
});

test("invalid prompt caching options fail during model construction", () => {
  for (const promptCaching of [true, null, [], { ttl: "2h" }, { cacheInstructions: "true" }]) {
    assert.throws(
      () => new AnthropicModel({ apiKey: "offline-body-inspection", model: "claude-sonnet-4-6", promptCaching }),
      TypeError,
    );
  }
  for (const promptCaching of [true, null, [], { ttl: "2h" }, { cacheInstructions: "true" }]) {
    assert.throws(
      () =>
        createBuiltinProviderModel({
          profile: "offline",
          provider: "anthropic",
          adapter: "anthropic-messages",
          model: "claude-sonnet-4-6",
          providerConfig: { apiKey: "offline-body-inspection" },
          options: { promptCaching },
        }),
      /promptCaching/,
    );
  }
});
