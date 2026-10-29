import assert from "node:assert/strict";
import test from "node:test";
import { loadMayConfig, resolveModelProfile } from "@sortedyuan/may/config";
import { GeminiModel, GEMINI_MODEL_STATE_TYPE, toGeminiRequestParts } from "@sortedyuan/providers/gemini";

async function readOptions() {
  const loaded = await loadMayConfig();
  const profile = process.env.MAY_GEMINI_MODEL_PROFILE ?? Object.keys(loaded.models).find((name) => resolveModelProfile(loaded, name).adapter === "google-gemini");
  assert.ok(profile, "Configure a google-gemini model profile or set MAY_GEMINI_MODEL_PROFILE");
  const selected = resolveModelProfile(loaded, profile);
  assert.equal(selected.adapter, "google-gemini");
  return { apiKey: selected.providerConfig.apiKey, baseURL: selected.providerConfig.baseURL, model: selected.model, ...selected.options };
}

async function complete(model, request) {
  const events = [];
  for await (const event of model.stream(request, { signal: AbortSignal.timeout(60000) })) events.push(event);
  const completed = events.at(-1);
  assert.equal(completed.type, "response.completed");
  return completed;
}

test("real Gemini tool execution continues after serialized signed history", { timeout: 150000 }, async () => {
  const model = new GeminiModel(await readOptions());
  const tools = [{ name: "gemini_add", description: "Add two numbers. Always use this function for the requested calculation.", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false } }];
  const messages = [{ role: "user", content: [{ type: "text", text: "必须调用 gemini_add 工具计算 19 加 23，收到工具结果后只回复计算结果。" }] }];
  const first = await complete(model, { messages, tools });
  assert.equal(first.message.toolCalls?.length, 1);
  const call = first.message.toolCalls[0];
  assert.equal(call.name, "gemini_add");
  assert.deepEqual(call.input, { a: 19, b: 23 });
  assert.equal(first.message.modelState.type, GEMINI_MODEL_STATE_TYPE);
  const history = JSON.parse(JSON.stringify([...messages, first.message, {
    role: "tool", toolCallId: call.id, name: call.name, content: [{ type: "json", value: call.input.a + call.input.b }],
  }]));
  const replay = toGeminiRequestParts(history);
  assert.deepEqual(replay.contents[1].parts, first.message.modelState.data.parts);
  const second = await complete(model, { messages: history, tools });
  assert.equal(second.message.toolCalls, undefined);
  assert.match(second.message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), /42/);
  console.log(JSON.stringify({ check: "tool-continuation", signedParts: first.message.modelState.data.parts.filter((part) => part.thoughtSignature).length, firstUsage: first.usage, secondUsage: second.usage }));
});

test("real Gemini structured output satisfies the requested schema", { timeout: 90000 }, async () => {
  const model = new GeminiModel(await readOptions());
  const result = await complete(model, {
    messages: [{ role: "user", content: [{ type: "text", text: 'Return JSON with a single property greeting whose value is "hello".' }] }],
    tools: [],
    responseFormat: { type: "jsonSchema", name: "greeting", schema: { type: "object", properties: { greeting: { type: "string", enum: ["hello"] } }, required: ["greeting"], additionalProperties: false } },
  });
  const text = result.message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.deepEqual(JSON.parse(text), { greeting: "hello" });
});

test("an aborted real Gemini request terminates without completion", { timeout: 10000 }, async () => {
  const model = new GeminiModel(await readOptions());
  const signal = AbortSignal.abort(new Error("Gemini integration cancellation"));
  await assert.rejects(async () => {
    for await (const event of model.stream({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], tools: [] }, { signal })) assert.notEqual(event.type, "response.completed");
  }, /Gemini integration cancellation/);
});
