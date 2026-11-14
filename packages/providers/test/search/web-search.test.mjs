import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ToolUsageError } from "@sortedyuan/may/core";
import { KimiFormulaError } from "../../dist/kimi/formula.js";
import {
  AnthropicModel,
  DeepSeekModel,
  KimiModel,
  OpenAIChatCompletionsModel,
  ProviderConfigurationError,
  ServerToolStateMismatchError,
  createKimiFormulaTools,
  builtinAdapterCapabilities,
  createModelCapabilityResolver,
  validateModelRequest,
} from "../../dist/index.js";
import {
  selectionWebSearch,
  validateWebSearch,
  webSearchRequest,
  serverToolOrigin,
  assertServerToolOrigin,
} from "../../dist/web-search.js";

const credentials = { apiKey: "validation-only", model: "validation-only" };

async function anthropicRequestBody(options, request) {
  let body;
  const model = new AnthropicModel({
    ...credentials,
    ...options,
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return Response.json(
        { type: "error", error: { type: "api_error", message: "request body captured" } },
        { status: 500 },
      );
    },
  });
  await assert.rejects(async () => {
    for await (const event of model.stream(request, { signal: new AbortController().signal })) void event;
  }, /request body captured/);
  return body;
}

test("Kimi Formula errors expose explicit usage receipts and preserve error details", () => {
  const usage = { completeness: { status: "partial", reason: "host-search-outcome-unknown" } };
  const cause = new Error("connection interrupted");
  const error = new KimiFormulaError("unknown outcome", "pending", "fiber", { usage, cause });
  assert.ok(error instanceof ToolUsageError);
  assert.deepEqual(error.usage, usage);
  assert.notEqual(error.usage, usage);
  assert.equal(error.cause, cause);
  assert.equal(error.code, "KIMI_FORMULA_ERROR");
  assert.equal(error.status, "pending");
  assert.equal(error.fiberId, "fiber");
});

test("webSearch construction rejects incompatible options without network access", async () => {
  for (const [adapter, options] of [
    ["anthropic-messages", { allowedDomains: [], blockedDomains: [] }],
    ["openai-responses", { allowedDomains: [], blockedDomains: [] }],
    ["anthropic-messages", { responseInclusion: "full" }],
    ["anthropic-messages", { version: "web_search_20260209", responseInclusion: "full" }],
    ["openai-responses", { userLocation: {} }],
    ["google-gemini", { timeRange: { startTime: "2026-11-01T00:00:00Z" } }],
    ["google-gemini", { timeRange: { endTime: "2026-11-01T00:00:00Z" } }],
    ["zhipu-chat", {}],
    ["anthropic-messages", { maxUses: 0 }],
    ["google-gemini", { searchTypes: ["invalid"] }],
  ])
    assert.throws(() => validateWebSearch(adapter, options), ProviderConfigurationError);
  for (const Model of [DeepSeekModel, KimiModel])
    for (const webSearch of [false, {}])
      assert.throws(() => new Model({ ...credentials, webSearch }), ProviderConfigurationError);
  assert.throws(() => new OpenAIChatCompletionsModel({ ...credentials, webSearch: {} }), ProviderConfigurationError);
  assert.throws(
    () => new OpenAIChatCompletionsModel({ ...credentials, model: "gpt-5-search-api", webSearch: false }),
    ProviderConfigurationError,
  );
  const conflicting = new AnthropicModel({
    ...credentials,
    webSearch: {},
    fetch: async () => assert.fail("a request with a conflicting web_search function was sent"),
  });
  await assert.rejects(async () => {
    for await (const event of conflicting.stream(
      { messages: [], tools: [{ name: "web_search", description: "search", inputSchema: {} }] },
      { signal: new AbortController().signal },
    ))
      void event;
  }, TypeError);
});

test("webSearch replacement and request field mapping", async () => {
  const selection = { options: { webSearch: {} }, providerConfig: { options: { webSearch: { maxUses: 4 } } } };
  assert.deepEqual(selectionWebSearch(selection), {});
  assert.equal(selectionWebSearch({ ...selection, options: { webSearch: false } }), false);
  assert.deepEqual(selectionWebSearch({ ...selection, options: {} }), { maxUses: 4 });
  assert.deepEqual(webSearchRequest("anthropic-messages", {}), { type: "web_search_20250305", name: "web_search" });
  assert.deepEqual(
    webSearchRequest("openai-responses", {
      allowedDomains: ["nodejs.org"],
      userLocation: { country: "SG" },
      searchContextSize: "high",
    }),
    {
      type: "web_search",
      filters: { allowed_domains: ["nodejs.org"] },
      user_location: { type: "approximate", country: "SG" },
      search_context_size: "high",
    },
  );
  assert.deepEqual(webSearchRequest("openai-chat-completions", { userLocation: { country: "SG" } }), {
    user_location: { type: "approximate", approximate: { country: "SG" } },
  });
  assert.deepEqual(
    webSearchRequest("google-gemini", {
      searchTypes: ["web", "image"],
      timeRange: { startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-07T00:00:00Z" },
    }),
    {
      googleSearch: {
        searchTypes: { webSearch: {}, imageSearch: {} },
        timeRangeFilter: { startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-07T00:00:00Z" },
      },
    },
  );
  assert.deepEqual(webSearchRequest("zhipu-chat", { searchEngine: "search_pro", count: 3 }), {
    type: "web_search",
    web_search: { enable: true, search_result: true, search_engine: "search_pro", count: 3 },
  });
  const body = await anthropicRequestBody(
    { webSearch: {}, promptCaching: { cacheInstructions: true } },
    { messages: [], tools: [{ name: "add", description: "add", inputSchema: {} }] },
  );
  assert.equal(body.tools.at(-1).name, "web_search");
  assert.equal(body.tools.at(-1).cache_control.type, "ephemeral");
});

test("unfinished server interactions validate adapter, model, endpoint and configuration", () => {
  const origin = serverToolOrigin("anthropic-messages", "claude", "https://api.anthropic.com", {
    name: "web_search",
    type: "web_search_20250305",
  });
  const message = {
    role: "assistant",
    content: [],
    continuation: "server-tool-pause",
    modelState: { type: "native", data: { origin } },
  };
  const request = { messages: [message], tools: [] };
  assert.doesNotThrow(() => assertServerToolOrigin(request, origin));
  for (const changed of [
    { ...origin, adapter: "openai-responses" },
    { ...origin, model: "other" },
    { ...origin, baseURL: "https://other.example" },
    { ...origin, toolsHash: "other" },
  ])
    assert.throws(() => assertServerToolOrigin(request, changed), ServerToolStateMismatchError);
  assert.deepEqual(serverToolOrigin("a", "b", "c", { x: 1, y: 2 }), serverToolOrigin("a", "b", "c", { y: 2, x: 1 }));
});

test("search capabilities validate unknown and unsupported combinations and record usage", async () => {
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  const selection = {
    profile: "search",
    provider: "openai",
    adapter: "openai-chat-completions",
    model: "gpt-5-search-api",
    providerConfig: { adapter: "openai-chat-completions" },
    options: {},
  };
  const capabilities = await resolver.resolve(selection);
  assert.equal(capabilities.fields["serverTools.alwaysSearches"].value, true);
  for (const adapter of [
    "anthropic-messages",
    "openai-responses",
    "openai-chat-completions",
    "google-gemini",
    "zhipu-chat",
  ])
    assert.equal(builtinAdapterCapabilities(adapter)["serverTools.webSearch"].value, true);
  for (const adapter of ["deepseek-chat", "kimi-chat"])
    assert.equal(builtinAdapterCapabilities(adapter)["serverTools.webSearch"].status, "unsupported");
  const request = { messages: [], tools: [] };
  assert.equal(
    validateModelRequest(request, capabilities, { serverTools: ["webSearch"], unknownPolicy: "require-known" }).status,
    "invalid",
  );
  const unsupported = await resolver.resolve({ ...selection, adapter: "deepseek-chat", model: "deepseek" });
  assert.equal(validateModelRequest(request, unsupported, { serverTools: ["webSearch"] }).status, "invalid");
  resolver.recordVerification(selection, request, true);
  assert.ok(resolver.verificationRecords().some((record) => record.capability === "serverTools.webSearch"));
});

test("Kimi Formula rejects invalid inputs before connecting", async () => {
  for (const options of [
    { apiKey: "", uri: "moonshot/web-search:latest" },
    { apiKey: "key", uri: "" },
    { apiKey: "key", uri: "../tools" },
    { apiKey: "key", uri: "moonshot/web-search:latest", timeoutMs: 0 },
    { apiKey: "key", uri: "moonshot/web-search:latest", baseURL: "file:///bad" },
  ])
    await assert.rejects(createKimiFormulaTools(options), {
      name: options.timeoutMs === 0 ? "RangeError" : "TypeError",
    });
});

test("replays recorded Anthropic search including citations, events, usage and native history", async () => {
  const recording = await readFile(new URL("../fixtures/search/anthropic-direct.sse", import.meta.url));
  const bodies = [];
  const model = new AnthropicModel({
    ...credentials,
    webSearch: {},
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(recording, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const events = [];
  for await (const event of model.stream(
    { messages: [{ role: "user", content: [{ type: "text", text: "Search" }] }], tools: [] },
    { signal: new AbortController().signal },
  ))
    events.push(event);
  const completed = events.at(-1);
  assert.equal(completed.type, "response.completed");
  assert.ok(events.some((event) => event.type === "server_tool.updated" && event.call.status === "pending"));
  assert.ok(events.some((event) => event.type === "server_tool.updated" && event.call.status === "completed"));
  assert.ok(completed.message.serverToolCalls.some((call) => call.sources.length > 0));
  assert.ok(completed.message.content.some((part) => part.citations?.length));
  assert.deepEqual(completed.usage, {
    inputTokens: 4200,
    outputTokens: 161,
    cachedReadTokens: 7808,
    cachedWriteTokens: 0,
    tokenRelations: { cachedRead: "total", cachedWrite: "total" },
    totalTokens: 12169,
  });
  for await (const event of model.stream(
    { messages: [completed.message], tools: [] },
    { signal: new AbortController().signal },
  ))
    void event;
  assert.deepEqual(bodies[1].messages[0].content, completed.message.modelState.data.content);
});

test("replays recorded mixed server search and client function calls with original arguments", async () => {
  const recordings = await Promise.all(
    ["anthropic-mixed-0.sse", "anthropic-mixed-1.sse"].map((name) =>
      readFile(new URL(`../fixtures/search/${name}`, import.meta.url)),
    ),
  );
  const requests = [];
  const model = new AnthropicModel({
    ...credentials,
    webSearch: { version: "web_search_20260209", allowedCallers: ["direct"] },
    fetch: async (_url, init) => {
      const recording = recordings[requests.length];
      assert.ok(recording, "Recorded response exists for this request");
      requests.push(JSON.parse(init.body));
      return new Response(recording, { headers: { "content-type": "text/event-stream" } });
    },
  });
  const tools = [
    {
      name: "add",
      description: "Add two numbers",
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
    },
  ];
  const messages = [{ role: "user", content: [{ type: "text", text: "Search and calculate 124 + 219 using add." }] }];
  let first;
  for await (const event of model.stream({ messages, tools }, { signal: new AbortController().signal }))
    if (event.type === "response.completed") first = event;
  const call = first.message.toolCalls[0];
  assert.equal(call.rawInput, '{"a":124,"b":219}');
  assert.deepEqual(JSON.parse(call.rawInput), call.input);
  assert.ok(first.message.serverToolCalls.some((call) => call.status === "completed"));
  messages.push(first.message, {
    role: "tool",
    toolCallId: call.id,
    name: call.name,
    content: [{ type: "text", text: String(call.input.a + call.input.b) }],
  });
  let second;
  for await (const event of model.stream({ messages, tools }, { signal: new AbortController().signal }))
    if (event.type === "response.completed") second = event;
  assert.ok(second.message.content.some((part) => part.citations?.length));
  assert.deepEqual(requests[1].messages[1].content, first.message.modelState.data.content);
  assert.ok(requests[1].messages.at(-1).content.every((part) => part.type === "tool_result"));
  assert.equal(requests[1].messages.at(-1).content[0].content, "343");
});
