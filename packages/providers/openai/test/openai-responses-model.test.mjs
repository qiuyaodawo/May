import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenAIResponsesError,
  OpenAIResponsesModel,
  OpenAIResponsesProtocolError,
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

function sseResponse(values, { chunkSize, lineBreak = "\n" } = {}) {
  const source = values
    .map((value) =>
      `data: ${typeof value === "string" ? value : JSON.stringify(value)}` +
      lineBreak + lineBreak
    )
    .join("");
  const bytes = new TextEncoder().encode(source);
  const size = chunkSize ?? bytes.length;
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += size) {
        controller.enqueue(bytes.slice(offset, offset + size));
      }
      controller.close();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completedResponse(output, usage = {
  input_tokens: 12,
  output_tokens: 7,
  total_tokens: 19,
}) {
  return {
    id: "resp_1",
    object: "response",
    status: "completed",
    output,
    usage,
  };
}

test("maps Responses requests, streaming deltas, output, tools, and usage", async () => {
  let capturedUrl;
  let capturedInit;
  const output = [
    {
      id: "rs_1",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "Think." }],
      encrypted_content: "opaque-reasoning",
    },
    {
      id: "msg_1",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Answer.", annotations: [] }],
    },
    {
      id: "fc_1",
      type: "function_call",
      call_id: "call_lookup",
      name: "lookup",
      arguments: "{\"q\":1}",
      status: "completed",
    },
  ];
  const fetch = async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return sseResponse([
      { type: "response.reasoning_summary_text.delta", delta: "Think." },
      { type: "response.output_text.delta", delta: "Answer." },
      { type: "response.completed", response: completedResponse(output) },
      "[DONE]",
    ], { chunkSize: 5, lineBreak: "\r\n" });
  };
  const model = new OpenAIResponsesModel({
    apiKey: "secret",
    model: "gpt-5.4",
    baseURL: "https://example.test/v1/",
    maxOutputTokens: 4096,
    reasoningEffort: "high",
    reasoningSummary: "auto",
    serverCompactThreshold: 100_000,
    fetch,
  });
  const signal = new AbortController().signal;
  const request = {
    messages: [
      { role: "system", content: [{ type: "text", text: "Be concise." }] },
      {
        role: "user",
        content: [
          { type: "text", text: "Find this" },
          { type: "json", value: { id: 1 } },
        ],
      },
    ],
    tools: [{
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { q: { type: "number" } },
        required: ["q"],
      },
    }],
  };

  const events = await collect(model.stream(request, { signal }));

  assert.equal(capturedUrl, "https://example.test/v1/responses");
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.headers.authorization, "Bearer secret");
  assert.equal(capturedInit.signal, signal);
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.model, "gpt-5.4");
  assert.equal(body.instructions, "Be concise.");
  assert.deepEqual(body.input, [{
    role: "user",
    content: [{ type: "input_text", text: "Find this\n{\"id\":1}" }],
  }]);
  assert.deepEqual(body.tools, [{
    type: "function",
    name: "lookup",
    description: "Look up a value",
    parameters: request.tools[0].inputSchema,
    strict: false,
  }]);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.max_output_tokens, 4096);
  assert.deepEqual(body.reasoning, {
    effort: "high",
    generate_summary: "auto",
  });
  assert.deepEqual(body.context_management, [{
    type: "compaction",
    compact_threshold: 100_000,
  }]);

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
  assert.deepEqual(events[2].message.toolCalls, [{
    id: "call_lookup",
    name: "lookup",
    input: { q: 1 },
  }]);
  assert.deepEqual(events[2].message.modelState.data.items, output);
});

test("round-trips native Responses output through a tool-result request", async () => {
  const requests = [];
  const firstOutput = [{
    type: "function_call",
    id: "fc_1",
    call_id: "call_add",
    name: "add",
    arguments: "{\"a\":2,\"b\":3}",
    status: "completed",
  }];
  const responses = [
    sseResponse([{
      type: "response.completed",
      response: completedResponse(firstOutput),
    }]),
    sseResponse([{
      type: "response.completed",
      response: completedResponse([{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "5", annotations: [] }],
      }]),
    }]),
  ];
  const model = new OpenAIResponsesModel({
    apiKey: "secret",
    model: "gpt-5.4",
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return responses.shift();
    },
  });
  const signal = new AbortController().signal;
  const first = await collect(model.stream(emptyRequest, { signal }));
  const assistant = first.at(-1).message;

  await collect(model.stream({
    messages: [
      ...emptyRequest.messages,
      assistant,
      {
        role: "tool",
        toolCallId: "call_add",
        content: [{ type: "json", value: 5 }],
      },
    ],
    tools: [],
  }, { signal }));

  assert.deepEqual(requests[1].input, [
    requests[0].input[0],
    firstOutput[0],
    { type: "function_call_output", call_id: "call_add", output: "5" },
  ]);
});

test("compacts context natively and reuses the opaque compacted output", async () => {
  const requests = [];
  const compactedOutput = [
    { role: "user", content: [{ type: "input_text", text: "old input" }] },
    { type: "compaction", id: "cmp_1", encrypted_content: "opaque-context" },
  ];
  const responses = [
    new Response(JSON.stringify({
      object: "response.compaction",
      output: compactedOutput,
      usage: { input_tokens: 900, output_tokens: 55, total_tokens: 955 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
    sseResponse([{
      type: "response.completed",
      response: completedResponse([{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "continued", annotations: [] }],
      }]),
    }]),
  ];
  const model = new OpenAIResponsesModel({
    apiKey: "secret",
    model: "gpt-5.4",
    fetch: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return responses.shift();
    },
  });
  const signal = new AbortController().signal;
  const result = await model.contextCompactor.compact({
    instructions: "Continue carefully.",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "old input" }],
    }],
    metadata: {},
  }, { signal, runId: "run-1", step: 3 });

  assert.equal(requests[0].url, "https://api.openai.com/v1/responses/compact");
  assert.deepEqual(requests[0].body, {
    model: "gpt-5.4",
    input: [{
      role: "user",
      content: [{ type: "input_text", text: "old input" }],
    }],
    instructions: "Continue carefully.",
  });
  assert.equal(result.effectiveTokens, 55);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].modelState.type, "openai.responses.output.v1");
  assert.deepEqual(result.messages[0].modelState.data.items, compactedOutput);

  await collect(model.stream({ messages: [...result.messages], tools: [] }, {
    signal,
  }));
  assert.deepEqual(requests[1].body.input, compactedOutput);
});

test("surfaces HTTP and malformed-stream failures", async () => {
  const apiModel = new OpenAIResponsesModel({
    apiKey: "secret",
    model: "gpt-5.4",
    fetch: async () => new Response(JSON.stringify({
      error: { message: "rate limited", type: "rate_limit_error" },
    }), {
      status: 429,
      headers: { "x-request-id": "req_123" },
    }),
  });
  await assert.rejects(
    collect(apiModel.stream(emptyRequest, {
      signal: new AbortController().signal,
    })),
    (error) => {
      assert.ok(error instanceof OpenAIResponsesError);
      assert.equal(error.status, 429);
      assert.equal(error.providerType, "rate_limit_error");
      assert.equal(error.requestId, "req_123");
      return true;
    },
  );

  const malformed = new OpenAIResponsesModel({
    apiKey: "secret",
    model: "gpt-5.4",
    fetch: async () => sseResponse([{
      type: "response.output_text.delta",
      delta: "unfinished",
    }]),
  });
  await assert.rejects(
    collect(malformed.stream(emptyRequest, {
      signal: new AbortController().signal,
    })),
    OpenAIResponsesProtocolError,
  );
});

test("validates required model options", () => {
  assert.throws(
    () => new OpenAIResponsesModel({ apiKey: "", model: "gpt-5.4" }),
    /apiKey must not be empty/,
  );
  assert.throws(
    () => new OpenAIResponsesModel({ apiKey: "key", model: "" }),
    /model must not be empty/,
  );
  assert.throws(
    () => new OpenAIResponsesModel({
      apiKey: "key",
      model: "gpt-5.4",
      serverCompactThreshold: 0,
    }),
    /serverCompactThreshold must be a positive safe integer/,
  );
});
