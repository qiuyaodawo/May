import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryContext, May } from "@may/core";
import { ZhipuApiError, ZhipuModel } from "../dist/index.js";

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

test("streams reasoning, text, usage, and sends Zhipu configuration", async () => {
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
  const model = new ZhipuModel({
    apiKey: "secret",
    model: "glm-5.2",
    baseURL: "https://example.test/",
    thinking: "enabled",
    clearThinking: true,
    reasoningEffort: "high",
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
  assert.equal(body.model, "glm-5.2");
  assert.deepEqual(body.messages, [{ role: "user", content: "Hello" }]);
  assert.equal("stream_options" in body, false);
  assert.deepEqual(body.thinking, {
    type: "enabled",
    clear_thinking: true,
  });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.max_tokens, 4096);
  assert.equal("tools" in body, false);
  assert.equal("tool_stream" in body, false);

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
    assert.ok(response, "unexpected extra Zhipu request");
    return response;
  };
  const model = new ZhipuModel({
    apiKey: "secret",
    model: "glm-5.2",
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
  assert.equal(requests[0].tool_stream, true);
  assert.deepEqual(requests[0].thinking, {
    type: "enabled",
    clear_thinking: false,
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
  assert.equal(secondMessages[2].content, "5");
  assert.deepEqual(
    events
      .filter((event) => event.type === "model.reasoning.delta")
      .map((event) => event.delta),
    ["I need the add tool.", "The tool returned five."],
  );
});

test("surfaces structured Zhipu HTTP errors", async () => {
  const fetch = async () => new Response(JSON.stringify({
    error: {
      message: "Authentication failed",
      code: 1002,
    },
  }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
  const model = new ZhipuModel({
    apiKey: "bad",
    model: "model",
    fetch,
  });

  await assert.rejects(
    collect(model.stream(emptyRequest, {
      signal: new AbortController().signal,
    })),
    (error) => {
      assert.ok(error instanceof ZhipuApiError);
      assert.equal(error.code, "ZHIPU_API_ERROR");
      assert.equal(error.status, 401);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.providerCode, 1002);
      return true;
    },
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
  const model = new ZhipuModel({
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

