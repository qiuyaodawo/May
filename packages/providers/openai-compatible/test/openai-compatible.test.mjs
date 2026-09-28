import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAIChatCompletionsProtocolError,
  streamOpenAICompatibleResponse,
  toOpenAICompatibleMessages,
  toOpenAICompatibleTools,
} from "../dist/index.js";
import { serializeError } from "@may/core";

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function collectFailure(iterable) {
  try {
    await collect(iterable);
  } catch (error) {
    return error;
  }
  assert.fail("the stream should have failed");
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
    {
      role: "user",
      content: [
        { type: "json", value: { question: 1 } },
        {
          type: "image",
          source: { type: "url", url: "https://example.test/image.png" },
          detail: "low",
        },
      ],
    },
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
    {
      role: "user",
      content: [
        { type: "text", text: "{\"question\":1}" },
        {
          type: "image_url",
          image_url: {
            url: "https://example.test/image.png",
            detail: "low",
          },
        },
      ],
    },
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

  assert.throws(() => toOpenAICompatibleMessages([{
    role: "user",
    content: [{
      type: "audio",
      source: { type: "url", url: "https://example.test/audio.mp3" },
    }],
  }]), /does not support audio content/);
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

test("exposes refusal text and serializes it into the next turn", async () => {
  const events = await collect(streamOpenAICompatibleResponse(sseResponse([
    {
      choices: [{
        index: 0,
        delta: { refusal: "I cannot help with that." },
        finish_reason: "stop",
      }],
    },
    "[DONE]",
  ]), streamOptions()));

  assert.deepEqual(events, [
    { type: "text.delta", delta: "I cannot help with that." },
    {
      type: "response.completed",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "I cannot help with that." }],
      },
    },
  ]);
  assert.deepEqual(toOpenAICompatibleMessages([events[1].message]), [{
    role: "assistant",
    content: "I cannot help with that.",
  }]);
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

test("fails on a server error reported inside a 200 stream", async (t) => {
  await t.test("error object with message, type, and string code", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(sseResponse([
        {
          choices: [{
            index: 0,
            delta: { content: "Working" },
            finish_reason: null,
          }],
        },
        {
          error: {
            message: "The model is overloaded, retry later.",
            type: "server_error",
            code: "overloaded",
          },
        },
        "[DONE]",
      ]), { ...streamOptions(), requireDone: true })),
      (error) =>
        error instanceof TestProtocolError &&
        error.message ===
          "TestProvider stream reported an error: The model is overloaded, retry later. type: server_error code: overloaded",
    );
  });

  await t.test("error object with a numeric code", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(sseResponse([
        {
          error: { message: "Request rejected.", code: 429, type: "api_error" },
        },
      ]), streamOptions())),
      (error) =>
        error instanceof TestProtocolError &&
        error.message ===
          "TestProvider stream reported an error: Request rejected. type: api_error code: 429",
    );
  });

  await t.test("string error", async () => {
    await assert.rejects(
      collect(streamOpenAICompatibleResponse(sseResponse([
        { error: "upstream connection reset" },
      ]), streamOptions())),
      (error) =>
        error instanceof TestProtocolError &&
        error.message ===
          "TestProvider stream reported an error: upstream connection reset",
    );
  });

  await t.test("error shapes without readable details", async () => {
    const expectations = new Map([
      [{}, "an error object without message, type, or code"],
      ["", "an empty error string"],
      ["   ", "an empty error string"],
      [null, "a null error value"],
      [42, "a number error value 42"],
      [[], "an array error value"],
      [{ message: "  " }, "an error object without message, type, or code"],
      [{ code: {} }, "an error object without message, type, or code"],
    ]);

    for (const [value, description] of expectations) {
      await assert.rejects(
        collect(streamOpenAICompatibleResponse(
          sseResponse([{ error: value }]),
          streamOptions(),
        )),
        (error) =>
          error instanceof TestProtocolError &&
          error.message ===
            `TestProvider stream reported an error: ${description}`,
        `error value ${JSON.stringify(value)}`,
      );
    }
  });

  await t.test("error takes precedence over DONE and finish reason", async () => {
    const collected = [];
    await assert.rejects(
      (async () => {
        for await (
          const event of streamOpenAICompatibleResponse(sseResponse([
            {
              choices: [{
                index: 0,
                delta: { content: "Partial answer" },
                finish_reason: null,
              }],
            },
            {
              choices: [{
                index: 0,
                delta: {},
                finish_reason: "stop",
              }],
            },
            { error: { message: "Stream aborted by the gateway." } },
            "[DONE]",
          ]), { ...streamOptions(), requireDone: true })
        ) {
          collected.push(event);
        }
      })(),
      (error) =>
        error instanceof TestProtocolError &&
        error.message ===
          "TestProvider stream reported an error: Stream aborted by the gateway.",
    );
    assert.deepEqual(collected, [
      { type: "text.delta", delta: "Partial answer" },
    ]);
  });

  await t.test(
    "keeps the server message when the stream ends without DONE",
    async () => {
      const error = await collectFailure(streamOpenAICompatibleResponse(
        sseResponse([
          { choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] },
          {
            error: {
              message: "Upstream provider closed the connection.",
              type: "server_error",
              code: "upstream_disconnect",
            },
          },
        ], 7),
        {
          signal: new AbortController().signal,
          providerName: "OpenAI-compatible chat",
          requireDone: true,
          protocolError: (message, options) =>
            new OpenAIChatCompletionsProtocolError(message, options),
          finishReasonError: (reason) => new Error(reason),
        },
      ));

      assert.ok(error instanceof OpenAIChatCompletionsProtocolError);
      const serialized = serializeError(error);
      assert.deepEqual(serialized, {
        name: "OpenAIChatCompletionsProtocolError",
        message:
          "OpenAI-compatible chat stream reported an error: Upstream provider closed the connection. type: server_error code: upstream_disconnect",
        code: "OPENAI_CHAT_COMPLETIONS_PROTOCOL_ERROR",
      });
    },
  );
});
