import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { parseMayConfig } from "@may/config";
import { ModelResponseValidationError } from "@may/core";
import { OpenAIChatCompletionsModel, OpenAIResponsesModel, createBuiltinProviderAdapterRegistry, createModelCapabilityResolver, validateModelRequest } from "../dist/index.js";

const responseFormat = {
  type: "jsonSchema",
  name: "echo",
  schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
  strict: true,
};
const request = { messages: [{ role: "user", content: [{ type: "text", text: "JSON echo" }] }], tools: [] };

async function startService(t) {
  const state = { catalogs: 0, requests: [], efforts: ["low", "high"], catalogStatus: 200, responseValue: "JSON echo", toolCalls: 0, capabilityFields: {} };
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === "GET" && incoming.url.startsWith("/v1/models?")) {
      state.catalogs += 1;
      await delay(10);
      outgoing.writeHead(state.catalogStatus, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ models: [{ slug: "local-echo", supported_reasoning_levels: state.efforts, default_reasoning_level: state.efforts[0] }] }));
      return;
    }
    if (incoming.method === "GET" && incoming.url === "/v1/capabilities") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify(state.capabilityFields));
      return;
    }
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.requests.push(body);
    if (incoming.url === "/v1/responses/compact") {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ object: "response.compaction", output: [{ type: "compaction", id: "local-compaction", encrypted_content: Buffer.from(JSON.stringify(body.input)).toString("base64") }], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }));
      return;
    }
    const content = JSON.stringify({ value: state.responseValue });
    outgoing.writeHead(200, { "content-type": "text/event-stream" });
    if (incoming.url === "/v1/responses") {
      outgoing.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}\n\n`);
      outgoing.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: content }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } })}\n\n`);
    } else {
      const delta = state.toolCalls === 0 ? { content } : { tool_calls: Array.from({ length: state.toolCalls }, (_, index) => ({ index, id: `call-${index}`, type: "function", function: { name: "echo", arguments: JSON.stringify({ value: state.responseValue }) } })) };
      outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      outgoing.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: state.toolCalls === 0 ? "stop" : "tool_calls" }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`);
      outgoing.end("data: [DONE]\n\n");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  return { ...state, state, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

function selection(baseURL, additions = {}) {
  return { profile: "local", provider: "local", adapter: "openai-chat-completions", model: "local-echo", providerConfig: { adapter: "openai-chat-completions", apiKey: "local-service-credential", baseURL }, options: {}, ...additions };
}
async function collect(iterable) { const output = []; for await (const event of iterable) output.push(event); return output; }
const streamOptions = () => ({ signal: new AbortController().signal });

test("通过本地HTTP catalog发现能力并验证缓存数量、并发请求和刷新", async (t) => {
  const service = await startService(t);
  const resolver = createModelCapabilityResolver({ maxCacheEntries: 1, cacheTtlMs: 40 });
  const selected = selection(service.baseURL);
  const first = await Promise.all([resolver.resolve(selected), resolver.resolve(selected)]);
  assert.equal(service.state.catalogs, 1);
  assert.deepEqual(first[0].reasoningEffort.efforts, ["low", "high"]);
  first[0].reasoningEffort.efforts.push("mutated");
  assert.deepEqual((await resolver.resolve(selected)).reasoningEffort.efforts, ["low", "high"]);
  service.state.efforts = ["medium", "high"];
  const refreshed = await Promise.all([resolver.resolve(selected, { refresh: true }), resolver.resolve(selected, { refresh: true })]);
  assert.equal(service.state.catalogs, 2);
  assert.deepEqual(refreshed[0].reasoningEffort.efforts, ["medium", "high"]);
  await resolver.resolve({ ...selected, model: "another-model" });
  await resolver.resolve(selected);
  assert.equal(service.state.catalogs, 4);
  await delay(50);
  await resolver.resolve(selected);
  assert.equal(service.state.catalogs, 5);
  await resolver.resolve({ ...selected, providerConfig: { ...selected.providerConfig, apiKey: "rotated-service-credential" } });
  assert.equal(service.state.catalogs, 6);
  resolver.invalidate(selected);
  service.state.catalogStatus = 503;
  const failed = await resolver.resolve(selected);
  assert.equal(failed.diagnostics[0].code, "DISCOVERY_FAILED");
  assert.equal(failed.reasoningEffort.status, "unknown");
  assert.ok(!JSON.stringify(failed).includes("local-service-credential"));
  service.state.catalogStatus = 200;
  assert.equal((await resolver.resolve(selected)).reasoningEffort.status, "known");
});

test("计算模型、adapter和连接声明的有效范围并在发送前拒绝请求", async (t) => {
  const service = await startService(t);
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  const selected = selection(service.baseURL, {
    capabilities: { fields: { "input.text": true, "input.image": true, "input.image.sources": ["url", "base64", "file"], maxImages: 1, maxAttachmentBytes: 2, "structuredOutput.jsonSchema": true } },
    providerConfig: { ...selection(service.baseURL).providerConfig, capabilities: { fields: { "input.image": false } } },
  });
  const capabilities = await resolver.resolve(selected);
  assert.equal(capabilities.fields["input.image"].status, "unsupported");
  assert.deepEqual(capabilities.fields["input.image.sources"].value, ["url", "base64"]);
  assert.equal(capabilities.layers.model["input.image"].status, "known");
  const imageRequest = { ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: Buffer.from("image").toString("base64") } }] }] };
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selected);
  await assert.rejects(collect(model.stream(imageRequest, streamOptions())), /input.image is unsupported/);
  assert.equal(model.lastValidation.status, "invalid");
  assert.equal(service.state.requests.length, 0);
  assert.equal(validateModelRequest(imageRequest, capabilities).status, "invalid");
  const fileIdRequest = { ...request, messages: [{ role: "user", content: [{ type: "image", source: { type: "file", fileId: "image-1" } }] }] };
  assert.ok(validateModelRequest(fileIdRequest, capabilities).issues.some((issue) => issue.message === "file source is unsupported"));
});

test("校验unknown严格策略、参数组合和资源限制", async (t) => {
  const service = await startService(t);
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  const selected = selection(service.baseURL, { options: { unknownCapabilityPolicy: "require-known" } });
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selected);
  await assert.rejects(collect(model.stream(request, streamOptions())), /input.text is unknown/);
  assert.equal(service.state.requests.length, 0);
  const knownText = await resolver.resolve({ ...selected, capabilities: { fields: { "input.text": true } } });
  assert.equal(validateModelRequest(request, knownText, { parameters: { temperature: 0.5 } }).status, "unknown");
  assert.equal(validateModelRequest(request, knownText, { parameters: { temperature: 0.5 }, unknownPolicy: "require-known" }).status, "invalid");
  const capabilities = await resolver.resolve({ ...selected, capabilities: { reasoning: { efforts: ["low", "high"] }, fields: { "input.text": true, maxOutputTokens: 4, contextWindowTokens: 8, parameters: { type: "object", properties: { temperature: { type: "number", minimum: 0, maximum: 1 }, maxOutputTokens: { type: "integer", minimum: 1, maximum: 4 } }, additionalProperties: false } } } });
  assert.equal(validateModelRequest(request, capabilities, { parameters: { temperature: 0.5 } }).status, "unknown");
  assert.equal(validateModelRequest(request, capabilities, { parameters: { temperature: 0.5, maxOutputTokens: 2 }, estimatedInputTokens: 6 }).status, "valid");
  assert.equal(validateModelRequest(request, capabilities, { parameters: { maxOutputTokens: 2 }, estimatedInputTokens: 7 }).status, "invalid");
  assert.equal(validateModelRequest(request, capabilities, { estimatedInputTokens: 6 }).status, "unknown");
  assert.equal(validateModelRequest(request, capabilities, { parameters: { temperature: 2 } }).status, "invalid");
  assert.equal(validateModelRequest(request, capabilities, { parameters: { maxOutputTokens: 5 } }).status, "invalid");
  assert.equal(validateModelRequest(request, capabilities, { estimatedInputTokens: 9 }).status, "invalid");
  assert.equal(validateModelRequest(request, capabilities, { parameters: { reasoningEffort: "max" } }).status, "invalid");
  const disabledOutput = await resolver.resolve({ ...selected, capabilities: { fields: { "input.text": true, maxOutputTokens: false } } });
  assert.ok(validateModelRequest(request, disabledOutput, { parameters: { maxOutputTokens: 1 } }).issues.some((issue) => issue.capability === "maxOutputTokens" && issue.code === "unsupported"));
});

test("发送配置的结构化格式并验证独立OpenAI adapter的返回结果", async (t) => {
  const service = await startService(t);
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  const selected = selection(service.baseURL, { options: { responseFormat }, capabilities: { fields: { "input.text": true, "structuredOutput.jsonSchema": true, "structuredOutput.schemaDialects": ["draft-07"], "structuredOutput.schemaConstraint": { type: "object" } } } });
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selected);
  const events = await collect(model.stream(request, streamOptions()));
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(service.state.requests[0].response_format.type, "json_schema");
  assert.deepEqual(service.state.requests[0].response_format.json_schema.schema, responseFormat.schema);
  assert.ok(model.capabilityVersion);
  assert.equal(model.lastValidation.status, "valid");
  assert.ok(resolver.verificationRecords(selected).every((record) => record.success));
  assert.ok(!JSON.stringify(resolver.verificationRecords(selected)).includes("local-service-credential"));
  const directChat = new OpenAIChatCompletionsModel({ apiKey: "local-service-credential", model: "local-echo", baseURL: service.baseURL });
  const directResponses = new OpenAIResponsesModel({ apiKey: "local-service-credential", model: "local-echo", baseURL: service.baseURL });
  await collect(directResponses.stream({ ...request, responseFormat }, streamOptions()));
  assert.equal(service.state.requests[1].text.format.type, "json_schema");
  service.state.responseValue = 10;
  await assert.rejects(collect(directChat.stream({ ...request, responseFormat }, streamOptions())), /does not satisfy responseFormat.schema/);
  await assert.rejects(collect(directResponses.stream({ ...request, responseFormat }, streamOptions())), /does not satisfy responseFormat.schema/);
  await assert.rejects(collect(model.stream(request, streamOptions())), (error) => {
    assert.ok(error instanceof ModelResponseValidationError);
    assert.equal(error.responseCompleted, true);
    assert.equal(error.usage.totalTokens, 5);
    return /does not satisfy responseFormat.schema/u.test(error.message);
  });
  assert.ok(resolver.verificationRecords(selected).some((record) => !record.success));
  const before = service.state.requests.length;
  await assert.rejects(collect(directChat.stream({ ...request, responseFormat: { ...responseFormat, schema: { $async: true, type: "object" } } }, streamOptions())), /synchronous JSON Schema/);
  await assert.rejects(collect(directChat.stream({ ...request, responseFormat: { ...responseFormat, strict: "true" } }, streamOptions())), /strict must be a boolean/);
  await assert.rejects(collect(directResponses.stream({ ...request, responseFormat: { type: "invalid" } }, streamOptions())), /must be a JSON or JSON Schema/);
  await assert.rejects(collect(directResponses.stream({ ...request, responseFormat: { ...responseFormat, schema: { type: "object", properties: { value: { $ref: "https://external.invalid/schema" } } } } }, streamOptions())), /can't resolve reference/);
  assert.equal(service.state.requests.length, before);
});

test("保存观测的媒体范围并执行连接声明的工具调用数量限制", async (t) => {
  const service = await startService(t);
  const resolver = createModelCapabilityResolver({ discoveries: [], maxVerificationRecords: 3 });
  const selected = selection(service.baseURL, { capabilities: { fields: { "input.text": true, "input.image": true, "input.image.sources": ["base64"], maxImages: 1, maxAttachmentBytes: 1024, tools: true } }, providerConfig: { ...selection(service.baseURL).providerConfig, capabilities: { fields: { "tools.maxCalls": 1 } } } });
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selected);
  const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const imageRequest = { messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", mediaType: "image/png", data: imageData } }] }], tools: [] };
  await collect(model.stream(imageRequest, streamOptions()));
  const evidence = resolver.verificationRecords(selected)[0];
  assert.equal(evidence.capability, "input.image");
  assert.equal(evidence.evidence, "request-accepted");
  assert.equal(evidence.parameters.count, 1);
  assert.equal(evidence.parameters.base64Sources, 1);
  assert.equal(evidence.parameters.knownBytesCount, 1);
  assert.equal(evidence.parameters.maxObservedBytes, Buffer.byteLength(imageData, "base64"));
  assert.ok(!JSON.stringify(evidence).includes(imageData));
  service.state.toolCalls = 1;
  const toolRequest = { ...request, responseFormat, tools: [{ name: "echo", description: "返回传入的值", inputSchema: responseFormat.schema }] };
  const formattedSelection = { ...selected, capabilities: { fields: { ...selected.capabilities.fields, "structuredOutput.jsonSchema": true, "structuredOutput.schemaDialects": ["draft-07"], "structuredOutput.schemaConstraint": { type: "object" } } } };
  const formattedModel = createBuiltinProviderAdapterRegistry({ resolver }).create(formattedSelection);
  const events = await collect(formattedModel.stream(toolRequest, streamOptions()));
  assert.equal(events.at(-1).message.content.length, 0);
  assert.equal(events.at(-1).message.toolCalls.length, 1);
  assert.ok(resolver.verificationRecords(selected).every((record) => record.evidence === "request-accepted"));
  service.state.toolCalls = 2;
  await assert.rejects(collect(formattedModel.stream(toolRequest, streamOptions())), (error) => {
    assert.ok(error instanceof ModelResponseValidationError);
    assert.equal(error.responseCompleted, true);
    assert.equal(error.usage.totalTokens, 5);
    return /exceeds tools.maxCalls/u.test(error.message);
  });
  assert.equal(resolver.verificationRecords(selected).length, 3);
  assert.ok(resolver.verificationRecords(selected).every((record) => record.evidence === "failed"));
});

test("通过能力wrapper校验原生Context压缩", async (t) => {
  const service = await startService(t);
  const resolver = createModelCapabilityResolver({ discoveries: [] });
  const selected = selection(service.baseURL, { adapter: "openai-responses", capabilities: { fields: { "input.text": true, contextCompaction: true } } });
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selected);
  const result = await model.contextCompactor.compact({ messages: request.messages }, streamOptions());
  assert.equal(result.messages[0].modelState.type, "openai.responses.output.v1");
  assert.deepEqual(JSON.parse(Buffer.from(result.messages[0].modelState.data.items[0].encrypted_content, "base64").toString("utf8")), service.state.requests[0].input);
  assert.equal(result.usage.outputTokens, 1);
  assert.equal(resolver.verificationRecords(selected).find((record) => record.capability === "contextCompaction").evidence, "request-accepted");
  const unavailable = createBuiltinProviderAdapterRegistry({ resolver }).create({ ...selected, capabilities: { fields: { "input.text": true, contextCompaction: false } } });
  await assert.rejects(unavailable.contextCompactor.compact({ messages: request.messages }, streamOptions()), /compaction capability is unavailable/);
  assert.equal(unavailable.lastValidation.status, "invalid");
  assert.equal(service.state.requests.length, 1);
});

test("拒绝实际自定义发现接口返回的非法metadata", async (t) => {
  const service = await startService(t);
  service.state.capabilityFields = { "input.text": { status: "known", source: "provider", value: "invalid-boolean" } };
  const resolver = createModelCapabilityResolver({ discoveries: [{ name: "local-metadata", async discoverCapabilities(selected) { return (await fetch(`${selected.providerConfig.baseURL}/capabilities`)).json(); } }] });
  await assert.rejects(resolver.resolve(selection(service.baseURL)), /must be a boolean/);
  service.state.capabilityFields = { "input.text": { status: "known", source: "provider", value: true } };
  const capabilities = await resolver.resolve(selection(service.baseURL), { fields: ["input.text"], refresh: true });
  assert.equal(capabilities.fields["input.text"].source, "provider");
  assert.equal(capabilities.fields["input.text"].value, true);
  assert.equal(Object.keys(capabilities.fields).length, 1);
});

test("模型限制保留配置和HTTP能力发现中的最小数值", async (t) => {
  const service = await startService(t);
  service.state.capabilityFields = { contextWindowTokens: { status: "known", source: "provider", value: 100 }, maxOutputTokens: { status: "known", source: "provider", value: 20 }, "input.text": { status: "known", source: "provider", value: true } };
  const resolver = createModelCapabilityResolver({ discoveries: [{ name: "local-limits", async discoverCapabilities(selected) { return (await fetch(`${selected.providerConfig.baseURL}/capabilities`)).json(); } }] });
  const selected = selection(service.baseURL, { limits: { contextWindowTokens: 200, maxOutputTokens: 32 }, providerConfig: { ...selection(service.baseURL).providerConfig, capabilities: { fields: { contextWindowTokens: 150, maxOutputTokens: 24 } } } });
  const model = createBuiltinProviderAdapterRegistry({ resolver }).create(selected);
  assert.deepEqual(model.limits, { contextWindowTokens: 150, maxOutputTokens: 24 });
  await model.getModelCapabilities();
  assert.deepEqual(model.limits, { contextWindowTokens: 150, maxOutputTokens: 24 });
  await assert.rejects(collect(model.stream(request, streamOptions())), /maxOutputTokens must not exceed 24/);
  assert.equal(service.state.requests.length, 0);
  const discovered = createBuiltinProviderAdapterRegistry({ resolver }).create(selection(service.baseURL));
  assert.equal(discovered.limits, undefined);
  await discovered.getModelCapabilities();
  assert.deepEqual(discovered.limits, { contextWindowTokens: 100, maxOutputTokens: 20 });
  service.state.capabilityFields.contextWindowTokens.value = 90;
  service.state.capabilityFields.maxOutputTokens.value = 15;
  await discovered.refreshCapabilities();
  assert.deepEqual(discovered.limits, { contextWindowTokens: 90, maxOutputTokens: 15 });
});

test("校验能力配置并保留reasoning覆盖配置的兼容性", () => {
  const config = parseMayConfig({ providers: { local: { adapter: "openai-chat-completions", capabilities: { fields: { "input.audio": false } } } }, models: { local: { provider: "local", model: "local-echo", capabilities: { reasoning: { efforts: ["low", "high"], defaultEffort: "low" }, fields: { "input.image.sources": ["base64"], maxImages: 4 } } } } });
  assert.equal(config.providers.local.capabilities.fields["input.audio"], false);
  assert.deepEqual(config.models.local.capabilities.reasoning.efforts, ["low", "high"]);
  assert.throws(() => parseMayConfig({ providers: { local: { adapter: "custom", capabilities: { fields: { maxImages: 0 } } } } }), /positive safe integer/);
  assert.throws(() => parseMayConfig({ providers: { local: { adapter: "custom", capabilities: { fields: { "input.image.sources": ["disk"] } } } } }), /sources must be/);
});
