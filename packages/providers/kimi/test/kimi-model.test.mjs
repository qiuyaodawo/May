import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContext, May } from "@may/core";
import {
  KimiApiError,
  KimiFinishReasonError,
  KimiModel,
  KimiProtocolError,
} from "../dist/index.js";

const emptyRequest = {
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  tools: [],
};

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function sseResponse(values, options = {}) {
  const lineBreak = options.lineBreak ?? "\n";
  const source = values
    .map((value) =>
      `data: ${typeof value === "string" ? value : JSON.stringify(value)}` +
      lineBreak + lineBreak
    )
    .join("");
  const bytes = new TextEncoder().encode(source);
  const chunkSize = options.chunkSize ?? bytes.length;

  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completionChunks({ reasoning = "", text = "", usage = true } = {}) {
  const chunks = [];
  if (reasoning) {
    chunks.push({
      choices: [{
        index: 0,
        delta: { reasoning_content: reasoning },
        finish_reason: null,
      }],
    });
  }
  if (text) {
    chunks.push({
      choices: [{
        index: 0,
        delta: { content: text },
        finish_reason: null,
      }],
    });
  }
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  if (usage) {
    chunks.push({
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  }
  chunks.push("[DONE]");
  return chunks;
}

test("streams reasoning, text, usage, and sends Kimi configuration", async () => {
  let capturedUrl;
  let capturedInit;
  const fetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return sseResponse(
      completionChunks({ reasoning: "Think.", text: "Answer." }),
      { lineBreak: "\r\n", chunkSize: 7 },
    );
  };
  const model = new KimiModel({
    apiKey: "secret",
    model: "kimi-k2.6",
    baseURL: "https://example.test/",
    thinking: { type: "enabled", keep: "all" },
    maxTokens: 4096,
    fetch,
  });
  const controller = new AbortController();

  const events = await collect(model.stream(emptyRequest, {
    signal: controller.signal,
  }));

  assert.equal(capturedUrl, "https://example.test/chat/completions");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers.authorization, "Bearer secret");
  assert.equal(capturedInit.headers["content-type"], "application/json");
  assert.equal(capturedInit.signal, controller.signal);

  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, "kimi-k2.6");
  assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.deepEqual(body.thinking, { type: "enabled", keep: "all" });
  assert.equal("reasoning_effort" in body, false);
  assert.equal(body.max_completion_tokens, 4096);
  assert.equal("max_tokens" in body, false);
  assert.equal("tools" in body, false);

  assert.deepEqual(events, [
    { type: "reasoning.delta", delta: "Think." },
    { type: "text.delta", delta: "Answer." },
    {
      type: "response.completed",
      message: {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Think." },
          { type: "text", text: "Answer." },
        ],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  ]);
});

test("sends K3 reasoning effort without a thinking object", async () => {
  let body;
  const model = new KimiModel({
    apiKey: "secret",
    model: "kimi-k3",
    reasoningEffort: "max",
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return sseResponse(completionChunks({ text: "Answer." }));
    },
  });

  await collect(model.stream(emptyRequest, {
    signal: new AbortController().signal,
  }));

  assert.equal(body.reasoning_effort, "max");
  assert.equal("thinking" in body, false);
});

test("round-trips reasoning_content through a May tool-call loop", async () => {
  const requests = [];
  const responses = [
    sseResponse([
      {
        choices: [{
          index: 0,
          delta: { reasoning_content: "I need the add tool." },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_add",
              type: "function",
              function: { name: "add", arguments: "{\"a\":2" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: ",\"b\":3}" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ]),
    sseResponse(completionChunks({
      reasoning: "The tool returned five.",
      text: "2 + 3 = 5",
    })),
  ];
  const fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const response = responses.shift();
    assert.ok(response, "unexpected extra Kimi request");
    return response;
  };
  const model = new KimiModel({
    apiKey: "secret",
    model: "kimi-k2.6",
    fetch,
  });
  const add = {
    name: "add",
    description: "Add two numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    async execute({ a, b }) {
      return a + b;
    },
  };
  const run = new May({
    model,
    tools: [add],
    context: new InMemoryContext(),
  }).run({ input: "What is 2 + 3?" });
  const eventPromise = collect(run.events);

  const result = await run.result;
  const events = await eventPromise;

  assert.equal(result.steps, 2);
  assert.equal(
    result.message.content.find((part) => part.type === "text").text,
    "2 + 3 = 5",
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools[0], {
    type: "function",
    function: {
      name: "add",
      description: "Add two numbers",
      parameters: add.inputSchema,
    },
  });

  const secondMessages = requests[1].messages;
  assert.deepEqual(secondMessages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
  ]);
  assert.equal(secondMessages[1].reasoning_content, "I need the add tool.");
  assert.equal(secondMessages[1].content, "");
  assert.deepEqual(secondMessages[1].tool_calls, [{
    id: "call_add",
    type: "function",
    function: { name: "add", arguments: "{\"a\":2,\"b\":3}" },
  }]);
  assert.equal(secondMessages[2].tool_call_id, "call_add");
  assert.equal(secondMessages[2].name, "add");
  assert.equal(secondMessages[2].content, "5");
  assert.deepEqual(
    events
      .filter((event) => event.type === "model.reasoning.delta")
      .map((event) => event.delta),
    ["I need the add tool.", "The tool returned five."],
  );
});

test("assembles multiple interleaved tool calls in index order", async () => {
  const fetch = async () => sseResponse([
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 1,
              id: "call_b",
              type: "function",
              function: { name: "second", arguments: "not-" },
            },
            {
              index: 0,
              id: "call_a",
              type: "function",
              function: { name: "first", arguments: "{\"x\":" },
            },
          ],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: "1}" } },
            { index: 1, function: { arguments: "json" } },
          ],
        },
        finish_reason: null,
      }],
    },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
    "[DONE]",
  ]);
  const model = new KimiModel({
    apiKey: "secret",
    model: "model",
    fetch,
  });

  const events = await collect(model.stream(emptyRequest, {
    signal: new AbortController().signal,
  }));
  const completed = events.at(-1);

  assert.deepEqual(completed.message.toolCalls, [
    { id: "call_a", name: "first", input: { x: 1 } },
    { id: "call_b", name: "second", input: "not-json" },
  ]);
});

test("preserves an explicitly empty reasoning_content for tool continuation", async () => {
  const requests = [];
  const responses = [
    sseResponse([
      {
        choices: [{
          index: 0,
          delta: {
            reasoning_content: "",
            tool_calls: [{
              index: 0,
              id: "call_ping",
              type: "function",
              function: { name: "ping", arguments: "{}" },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ]),
    sseResponse(completionChunks({ text: "pong" })),
  ];
  const model = new KimiModel({
    apiKey: "secret",
    model: "model",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return responses.shift();
    },
  });
  const run = new May({
    model,
    tools: [{
      name: "ping",
      description: "Return pong",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        return "pong";
      },
    }],
    context: new InMemoryContext(),
  }).run({ input: "ping" });

  await run.result;

  const assistant = requests[1].messages[1];
  assert.equal(
    Object.hasOwn(assistant, "reasoning_content"),
    true,
  );
  assert.equal(assistant.reasoning_content, "");
});

test("surfaces structured Kimi HTTP errors", async () => {
  const fetch = async () => new Response(JSON.stringify({
    error: {
      message: "Authentication failed",
      type: "incorrect_api_key_error",
    },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  const model = new KimiModel({
    apiKey: "bad",
    model: "model",
    fetch,
  });

  await assert.rejects(
    collect(model.stream(emptyRequest, {
      signal: new AbortController().signal,
    })),
    (error) => {
      assert.ok(error instanceof KimiApiError);
      assert.equal(error.code, "KIMI_API_ERROR");
      assert.equal(error.status, 401);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.providerType, "incorrect_api_key_error");
      return true;
    },
  );
});

test("rejects malformed and incomplete Kimi streams", async (t) => {
  async function rejectStream(values, ErrorType, code) {
    const model = new KimiModel({
      apiKey: "secret",
      model: "model",
      fetch: async () => sseResponse(values),
    });
    await assert.rejects(
      collect(model.stream(emptyRequest, {
        signal: new AbortController().signal,
      })),
      (error) => error instanceof ErrorType && error.code === code,
    );
  }

  await t.test("invalid JSON", () =>
    rejectStream(["{"], KimiProtocolError, "KIMI_PROTOCOL_ERROR"));
  await t.test("missing finish reason", () =>
    rejectStream([
      { choices: [{ index: 0, delta: { content: "partial" } }] },
      "[DONE]",
    ], KimiProtocolError, "KIMI_PROTOCOL_ERROR"));
  await t.test("length finish reason", () =>
    rejectStream([
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
      "[DONE]",
    ], KimiFinishReasonError, "KIMI_INCOMPLETE_RESPONSE"));
  await t.test("tool finish without calls", () =>
    rejectStream([
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ], KimiProtocolError, "KIMI_PROTOCOL_ERROR"));
  await t.test("incomplete tool call", () =>
    rejectStream([
      {
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: "call_missing_name" }] },
          finish_reason: null,
        }],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      "[DONE]",
    ], KimiProtocolError, "KIMI_PROTOCOL_ERROR"));
  await t.test("missing DONE marker", () =>
    rejectStream([
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ], KimiProtocolError, "KIMI_PROTOCOL_ERROR"));
});

test("rejects a successful response without a streaming body", async () => {
  const model = new KimiModel({
    apiKey: "secret",
    model: "model",
    fetch: async () => new Response(null, { status: 200 }),
  });

  await assert.rejects(
    collect(model.stream(emptyRequest, {
      signal: new AbortController().signal,
    })),
    (error) =>
      error instanceof KimiProtocolError &&
      error.code === "KIMI_PROTOCOL_ERROR",
  );
});

test("passes AbortSignal to fetch and propagates cancellation", async () => {
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let receivedSignal;
  const fetch = async (_url, init) => {
    receivedSignal = init.signal;
    markStarted();
    return new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), {
        once: true,
      });
    });
  };
  const model = new KimiModel({
    apiKey: "secret",
    model: "model",
    fetch,
  });
  const controller = new AbortController();
  const collecting = collect(model.stream(emptyRequest, {
    signal: controller.signal,
  }));

  await started;
  const reason = new Error("stop request");
  controller.abort(reason);

  await assert.rejects(collecting, /stop request/);
  assert.equal(receivedSignal, controller.signal);
  assert.equal(receivedSignal.reason, reason);
});

test("validates required constructor options", () => {
  assert.throws(
    () => new KimiModel({ apiKey: "", model: "model" }),
    /apiKey must not be empty/,
  );
  assert.throws(
    () => new KimiModel({ apiKey: "secret", model: "" }),
    /model must not be empty/,
  );
  assert.throws(
    () => new KimiModel({
      apiKey: "secret",
      model: "model",
      maxTokens: 0,
    }),
    /maxTokens must be a positive safe integer/,
  );
});
