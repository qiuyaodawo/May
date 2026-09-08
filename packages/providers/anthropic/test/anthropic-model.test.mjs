import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContext, May } from "@may/core";
import {
  ANTHROPIC_MODEL_STATE_TYPE,
  AnthropicApiError,
  AnthropicFinishReasonError,
  AnthropicModel,
  AnthropicProtocolError,
  AnthropicStreamError,
} from "../dist/index.js";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function sseResponse(events, chunkSize = Infinity) {
  const source = events
    .map(({ event, data }) =>
      `event: ${event ?? data.type}\n` +
      `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`
    )
    .join("");
  const bytes = new TextEncoder().encode(source);

  return new Response(new ReadableStream({
    start(controller) {
      const size = Number.isFinite(chunkSize) ? chunkSize : bytes.length;
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }
      controller.close();
    },
  }), { status: 200 });
}

function simpleResponse(text = "done", stopReason = "end_turn") {
  return sseResponse([
    {
      data: {
        type: "message_start",
        message: {
          id: "msg_simple",
          content: [],
          usage: { input_tokens: 2, output_tokens: 1 },
        },
      },
    },
    {
      data: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    },
    {
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { data: { type: "content_block_stop", index: 0 } },
    {
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: 3 },
      },
    },
    { data: { type: "message_stop" } },
  ]);
}

function request(messages = [{
  role: "user",
  content: [{ type: "text", text: "hello" }],
}], tools = []) {
  return { messages, tools };
}

test("streams thinking, text, usage, and sends Anthropic configuration", async () => {
  let capturedUrl;
  let capturedInit;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    baseURL: "https://anthropic.test/",
    apiVersion: "2023-06-01",
    maxTokens: 8192,
    thinking: { type: "adaptive", display: "summarized" },
    reasoningEffort: "high",
    async fetch(url, init) {
      capturedUrl = url;
      capturedInit = init;
      return sseResponse([
        {
          data: {
            type: "message_start",
            message: {
              id: "msg_1",
              content: [],
              usage: { input_tokens: 12, output_tokens: 1 },
            },
          },
        },
        { event: "future_event", data: { type: "future_event", value: 1 } },
        {
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          },
        },
        {
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Think." },
          },
        },
        {
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "signature_1" },
          },
        },
        { data: { type: "content_block_stop", index: 0 } },
        {
          data: {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
        },
        {
          data: {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "Answer." },
          },
        },
        { data: { type: "content_block_stop", index: 1 } },
        {
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 7 },
          },
        },
        { data: { type: "message_stop" } },
      ], 5);
    },
  });
  const signal = new AbortController().signal;
  const events = await collect(model.stream(request([
    { role: "system", content: [{ type: "text", text: "Be concise." }] },
    {
      role: "user",
      content: [
        { type: "json", value: { question: 1 } },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image.png" },
        },
        {
          type: "file",
          name: "notes.pdf",
          source: {
            type: "base64",
            mediaType: "application/pdf",
            data: "cGRm",
          },
        },
      ],
    },
  ], [{
    name: "lookup",
    description: "Look up a value",
    inputSchema: { type: "object" },
  }]), { signal }));

  assert.equal(capturedUrl, "https://anthropic.test/v1/messages");
  assert.equal(capturedInit.signal, signal);
  const headers = new Headers(capturedInit.headers);
  assert.equal(headers.get("x-api-key"), "test-key");
  assert.equal(headers.get("anthropic-version"), "2023-06-01");
  assert.equal(headers.get("anthropic-beta"), null);
  assert.equal(headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(capturedInit.body), {
    model: "test-model",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "{\"question\":1}" },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image.png" },
        },
        {
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "cGRm",
          },
        },
      ],
    }],
    stream: true,
    system: "Be concise.",
    tools: [{
      name: "lookup",
      description: "Look up a value",
      input_schema: { type: "object" },
    }],
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "high" },
  });
  assert.deepEqual(events.slice(0, 2), [
    { type: "reasoning.delta", delta: "Think." },
    { type: "text.delta", delta: "Answer." },
  ]);
  assert.deepEqual(events[2].usage, {
    inputTokens: 12,
    outputTokens: 7,
    totalTokens: 19,
  });
  assert.deepEqual(events[2].message.content, [
    { type: "reasoning", text: "Think." },
    { type: "text", text: "Answer." },
  ]);
  assert.deepEqual(events[2].message.modelState, {
    type: ANTHROPIC_MODEL_STATE_TYPE,
    data: {
      messageId: "msg_1",
      content: [
        { type: "thinking", thinking: "Think.", signature: "signature_1" },
        { type: "text", text: "Answer." },
      ],
    },
  });
});

test("enables the Files API beta only for file-id references", async () => {
  let headers;
  let body;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    async fetch(_url, init) {
      headers = new Headers(init.headers);
      body = JSON.parse(init.body);
      return simpleResponse();
    },
  });

  await collect(model.stream(request([{
    role: "user",
    content: [{
      type: "file",
      name: "notes.pdf",
      source: { type: "file", fileId: "file_123" },
    }],
  }]), { signal: new AbortController().signal }));

  assert.equal(headers.get("anthropic-beta"), "files-api-2025-04-14");
  assert.deepEqual(body.messages, [{
    role: "user",
    content: [{
      type: "document",
      source: { type: "file", file_id: "file_123" },
    }],
  }]);
});

test("round-trips signed and redacted thinking through a May tool loop", async () => {
  const bodies = [];
  let call = 0;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    maxTokens: 2048,
    thinking: { type: "enabled", budgetTokens: 1024 },
    async fetch(_url, init) {
      bodies.push(JSON.parse(init.body));
      call += 1;
      if (call === 1) {
        return sseResponse([
          {
            data: {
              type: "message_start",
              message: { id: "msg_tool", usage: { input_tokens: 8 } },
            },
          },
          {
            data: {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "thinking",
                thinking: "",
                signature: "",
              },
            },
          },
          {
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "thinking_delta", thinking: "Use add." },
            },
          },
          {
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "signature_delta", signature: "signed" },
            },
          },
          { data: { type: "content_block_stop", index: 0 } },
          {
            data: {
              type: "content_block_start",
              index: 1,
              content_block: { type: "redacted_thinking", data: "encrypted" },
            },
          },
          { data: { type: "content_block_stop", index: 1 } },
          {
            data: {
              type: "content_block_start",
              index: 2,
              content_block: {
                type: "tool_use",
                id: "toolu_1",
                name: "add",
                input: {},
              },
            },
          },
          {
            data: {
              type: "content_block_delta",
              index: 2,
              delta: { type: "input_json_delta", partial_json: "{\"a\":2," },
            },
          },
          {
            data: {
              type: "content_block_delta",
              index: 2,
              delta: { type: "input_json_delta", partial_json: "\"b\":3}" },
            },
          },
          { data: { type: "content_block_stop", index: 2 } },
          {
            data: {
              type: "message_delta",
              delta: { stop_reason: "tool_use" },
              usage: { output_tokens: 12 },
            },
          },
          { data: { type: "message_stop" } },
        ]);
      }
      return simpleResponse("2 + 3 = 5");
    },
  });
  const context = new InMemoryContext({ instructions: "Use tools." });
  const run = new May({
    model,
    context,
    tools: [{
      name: "add",
      description: "Add numbers",
      inputSchema: { type: "object" },
      async execute({ a, b }) {
        return a + b;
      },
    }],
  }).run({ input: "add 2 and 3" });
  const eventPromise = collect(run.events);
  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.steps, 2);
  assert.equal(result.message.content[0].text, "2 + 3 = 5");
  assert.ok(events.some((event) => event.type === "model.reasoning.delta"));
  assert.ok(events.some((event) => event.type === "tool.completed"));
  assert.deepEqual(bodies[0].thinking, {
    type: "enabled",
    budget_tokens: 1024,
  });
  assert.deepEqual(bodies[1].messages, [
    {
      role: "user",
      content: [{ type: "text", text: "add 2 and 3" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Use add.", signature: "signed" },
        { type: "redacted_thinking", data: "encrypted" },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "add",
          input: { a: 2, b: 3 },
        },
      ],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "5",
      }],
    },
  ]);

  const firstAssistant = (await context.snapshot()).messages
    .find((message) => message.role === "assistant");
  assert.equal(firstAssistant.modelState.type, ANTHROPIC_MODEL_STATE_TYPE);
  assert.equal(firstAssistant.modelState.data.content[0].signature, "signed");
});

test("falls back to normalized content when model state belongs to another adapter", async () => {
  let body;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    async fetch(_url, init) {
      body = JSON.parse(init.body);
      return simpleResponse();
    },
  });
  await collect(model.stream(request([
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "text", text: "visible" },
      ],
      modelState: {
        type: "another.provider/response-v1",
        data: { responseId: "response_1" },
      },
    },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]), { signal: new AbortController().signal }));

  assert.deepEqual(body.messages, [
    {
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    },
    {
      role: "user",
      content: [{ type: "text", text: "continue" }],
    },
  ]);
  assert.equal(body.max_tokens, 4096);
});

test("converts normalized tool calls and failed tool results", async () => {
  let body;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    thinking: { type: "disabled" },
    async fetch(_url, init) {
      body = JSON.parse(init.body);
      return simpleResponse();
    },
  });
  await collect(model.stream(request([
    { role: "user", content: [{ type: "text", text: "look up" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Calling." }],
      toolCalls: [{ id: "toolu_1", name: "lookup", input: { id: 1 } }],
    },
    {
      role: "tool",
      toolCallId: "toolu_1",
      name: "lookup",
      isError: true,
      content: [{ type: "json", value: { message: "failed" } }],
    },
  ]), { signal: new AbortController().signal }));

  assert.deepEqual(body.messages.slice(1), [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Calling." },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "lookup",
          input: { id: 1 },
        },
      ],
    },
    {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "toolu_1",
        content: "{\"message\":\"failed\"}",
        is_error: true,
      }],
    },
  ]);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("surfaces structured Anthropic HTTP errors", async () => {
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    async fetch() {
      return new Response(JSON.stringify({
        type: "error",
        error: { type: "invalid_request_error", message: "bad request" },
        request_id: "req_body",
      }), {
        status: 400,
        headers: { "request-id": "req_header" },
      });
    },
  });

  await assert.rejects(
    collect(model.stream(request(), { signal: new AbortController().signal })),
    (error) =>
      error instanceof AnthropicApiError &&
      error.status === 400 &&
      error.providerType === "invalid_request_error" &&
      error.requestId === "req_body" &&
      error.message === "bad request",
  );
});

test("rejects malformed and incomplete Anthropic streams", async (t) => {
  async function rejects(response, predicate) {
    const model = new AnthropicModel({
      apiKey: "test-key",
      model: "test-model",
      async fetch() {
        return response;
      },
    });
    await assert.rejects(
      collect(model.stream(request(), { signal: new AbortController().signal })),
      predicate,
    );
  }

  await t.test("invalid JSON", async () => {
    await rejects(sseResponse([{ event: "message_start", data: "{" }]),
      (error) =>
        error instanceof AnthropicProtocolError &&
        error.message === "Anthropic emitted invalid SSE JSON");
  });

  await t.test("missing message_stop", async () => {
    await rejects(sseResponse([
      {
        data: {
          type: "message_start",
          message: { id: "msg_1", usage: {} },
        },
      },
      {
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      },
    ]), (error) =>
      error instanceof AnthropicProtocolError &&
      error.message.includes("without a message_stop"));
  });

  await t.test("unsupported stop reason", async () => {
    await rejects(simpleResponse("partial", "max_tokens"),
      (error) =>
        error instanceof AnthropicFinishReasonError &&
        error.finishReason === "max_tokens");
  });

  await t.test("tool stop without a tool call", async () => {
    await rejects(simpleResponse("", "tool_use"),
      (error) =>
        error instanceof AnthropicProtocolError &&
        error.message.includes("emitted no tool calls"));
  });

  await t.test("invalid tool input JSON", async () => {
    await rejects(sseResponse([
      {
        data: {
          type: "message_start",
          message: { id: "msg_tool", usage: {} },
        },
      },
      {
        data: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_1",
            name: "lookup",
            input: {},
          },
        },
      },
      {
        data: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{" },
        },
      },
      { data: { type: "content_block_stop", index: 0 } },
    ]), (error) =>
      error instanceof AnthropicProtocolError &&
      error.message.includes("invalid tool input JSON"));
  });

  await t.test("in-stream error", async () => {
    await rejects(sseResponse([{
      data: {
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
        request_id: "req_stream",
      },
    }]), (error) =>
      error instanceof AnthropicStreamError &&
      error.providerType === "overloaded_error" &&
      error.requestId === "req_stream" &&
      error.message === "Overloaded");
  });

  await t.test("missing response body", async () => {
    await rejects(new Response(null, { status: 200 }),
      (error) =>
        error instanceof AnthropicProtocolError &&
        error.message === "Anthropic response has no body");
  });
});

test("rejects malformed Anthropic model state before sending a request", async () => {
  let fetched = false;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    async fetch() {
      fetched = true;
      return simpleResponse();
    },
  });
  await assert.rejects(collect(model.stream(request([{
    role: "assistant",
    content: [],
    modelState: { type: ANTHROPIC_MODEL_STATE_TYPE, data: null },
  }, {
    role: "user",
    content: [{ type: "text", text: "continue" }],
  }]), { signal: new AbortController().signal })), AnthropicProtocolError);
  assert.equal(fetched, false);
});

test("passes AbortSignal to fetch and propagates cancellation", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let capturedSignal;
  const model = new AnthropicModel({
    apiKey: "test-key",
    model: "test-model",
    async fetch(_url, init) {
      capturedSignal = init.signal;
      throw init.signal.reason;
    },
  });
  controller.abort(reason);

  await assert.rejects(
    collect(model.stream(request(), { signal: controller.signal })),
    (error) => error === reason,
  );
  assert.equal(capturedSignal, controller.signal);
});

