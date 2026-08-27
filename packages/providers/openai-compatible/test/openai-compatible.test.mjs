import assert from "node:assert/strict";
import test from "node:test";

import {
  streamOpenAICompatibleResponse,
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
} from "../dist/index.js";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function sseResponse(values, chunkSize = Infinity) {
  const source = values
    .map((value) =>
      `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`
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

function streamOptions(signal = new AbortController().signal) {
  return {
    signal,
    providerName: "TestProvider",
    protocolError(message, options) {
      return new TestProtocolError(message, options);
    },
    finishReasonError(reason) {
      return new TestFinishReasonError(reason);
    },
  };
}

class TestProtocolError extends Error {}

class TestFinishReasonError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

test("converts May messages and tools to the compatible wire format", () => {
  const messages = toOpenAICompatibleMessages([
    { role: "system", content: [{ type: "text", text: "System" }] },
    { role: "user", content: [{ type: "json", value: { question: 1 } }] },
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "" },
        { type: "text", text: "Calling." },
      ],
      toolCalls: [{ id: "call_1", name: "lookup", input: { id: 1 } }],
      modelState: {
        type: "another.provider/response-v1",
        data: { responseId: "response_1" },
      },
    },
    {
      role: "tool",
      toolCallId: "call_1",
      name: "lookup",
      content: [{ type: "json", value: { found: true } }],
    },
  ]);

  assert.deepEqual(messages, [
    { role: "system", content: "System" },
    { role: "user", content: "{\"question\":1}" },
    {
      role: "assistant",
      content: "Calling.",
      reasoning_content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "lookup", arguments: "{\"id\":1}" },
      }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "{\"found\":true}",
    },
  ]);

  assert.deepEqual(toOpenAICompatibleTools([{
    name: "lookup",
    description: "Find an item",
    inputSchema: { type: "object" },
  }]), [{
    type: "function",
    function: {
      name: "lookup",
      description: "Find an item",
      parameters: { type: "object" },
    },
  }]);

  assert.deepEqual(toOpenAICompatibleMessages([{
    role: "tool",
    toolCallId: "call_1",
    name: "lookup",
    content: [{ type: "text", text: "found" }],
  }], { includeToolName: true }), [{
    role: "tool",
    tool_call_id: "call_1",
    name: "lookup",
    content: "found",
  }]);
});

test("assembles fragmented reasoning, text, tools, and usage", async () => {
  const response = sseResponse([
    {
      choices: [{
        index: 0,
        delta: { reasoning_content: "Think." },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: { content: "Calling tool." },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":" },
          }],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: "1}" } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 6,
        total_tokens: 10,
      },
    },
    "[DONE]",
  ], 5);

  const events = await collect(streamOpenAICompatibleResponse(
    response,
    streamOptions(),
  ));

  assert.deepEqual(events, [
    { type: "reasoning.delta", delta: "Think." },
    { type: "text.delta", delta: "Calling tool." },
    {
      type: "response.completed",
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Think." },
          { type: "text", text: "Calling tool." },
        ],
        toolCalls: [{ id: "call_1", name: "lookup", input: { id: 1 } }],
      },
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    },
  ]);
});

test("uses provider error factories for malformed streams", async (t) => {
  await t.test("invalid JSON", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(
        sseResponse(["{"]),
        streamOptions(),
      )),
      (error) =>
        error instanceof TestProtocolError &&
        error.message === "TestProvider emitted invalid SSE JSON",
    );
  });

  await t.test("unsupported finish reason", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(sseResponse([
        { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
        "[DONE]",
      ]), streamOptions())),
      (error) =>
        error instanceof TestFinishReasonError && error.reason === "length",
    );
  });

  await t.test("missing body", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(
        new Response(null, { status: 200 }),
        streamOptions(),
      )),
      (error) =>
        error instanceof TestProtocolError &&
        error.message === "TestProvider response has no body",
    );
  });

  await t.test("required DONE marker", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(sseResponse([
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      ]), {
        ...streamOptions(),
        requireDone: true,
      })),
      (error) =>
        error instanceof TestProtocolError &&
        error.message === "TestProvider stream ended without [DONE]",
    );
  });
});
