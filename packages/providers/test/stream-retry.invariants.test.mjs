import assert from "node:assert/strict";
import test from "node:test";
import { fc, pbtRuns } from "@sortedyuan/test-support";
import { RetryingModel } from "../dist/index.js";
import { streamAnthropicResponse } from "../dist/anthropic/stream.js";
import { streamOpenAIResponse } from "../dist/openai/stream.js";
import { streamOpenAICompatibleResponse } from "../dist/openai-compatible/stream.js";

const MULTIBYTE_TOKENS = ["hello", "你好世界", "café", "naïve", "🚀🧪", "👨‍👩‍👧‍👦", "line\nbreak", 'quote"\\'];
const utf8DeltaArb = fc
  .array(fc.oneof(fc.constantFrom(...MULTIBYTE_TOKENS), fc.string({ minLength: 1, maxLength: 12 })), {
    minLength: 1,
    maxLength: 4,
  })
  .map((parts) => parts.join("").replaceAll("\u0000", ""))
  .filter((s) => s.length > 0);

function chunkedResponse(rawString, cutPoints, forceContinuationSplits = false) {
  const bytes = Buffer.from(rawString, "utf8");
  const points = [...cutPoints];
  if (forceContinuationSplits) {
    // Guarantee chunk boundaries fall inside multi-byte UTF-8 sequences and CRLF pairs.
    for (let i = 1; i < bytes.length; i += 1) {
      if ((bytes[i] & 0xc0) === 0x80 || (bytes[i - 1] === 0x0d && bytes[i] === 0x0a)) {
        points.push(i);
      }
    }
  }
  const sorted = [...new Set(points.map((n) => Math.max(0, Math.min(bytes.length, n))))].sort((a, b) => a - b);
  const stream = new ReadableStream({
    start(controller) {
      let cursor = 0;
      for (const next of sorted) {
        if (next > cursor) {
          controller.enqueue(bytes.subarray(cursor, next));
          cursor = next;
        }
      }
      if (cursor < bytes.length) {
        controller.enqueue(bytes.subarray(cursor));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const request = {
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
};

test("invariant: Anthropic SSE stream produces identical ModelEvents under arbitrary & mid-UTF-8 byte chunk splits", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(utf8DeltaArb, { minLength: 1, maxLength: 5 }),
      fc.record({ key: fc.stringMatching(/^[a-z0-9]{1,8}$/), count: fc.integer({ min: 0, max: 100 }) }),
      fc.array(fc.integer({ min: 0, max: 4096 }), { minLength: 1, maxLength: 40 }),
      fc.constantFrom("\n", "\r\n"),
      async (deltas, toolArg, cuts, eol) => {
        const argJson = JSON.stringify(toolArg);
        const mid = Math.floor(argJson.length / 2);
        const events = [
          {
            type: "message_start",
            message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          ...deltas.map((delta) => ({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: delta },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "toolu_1", name: "calc", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: argJson.slice(0, mid) },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: argJson.slice(mid) },
          },
          { type: "content_block_stop", index: 1 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ];
        const sse = events.map((ev) => `data: ${JSON.stringify(ev)}${eol}${eol}`).join("");
        const whole = await collect(streamAnthropicResponse(chunkedResponse(sse, []), new AbortController().signal));
        const split = await collect(
          streamAnthropicResponse(chunkedResponse(sse, cuts, true), new AbortController().signal),
        );
        assert.deepEqual(split, whole);
      },
    ),
    { numRuns: pbtRuns(80) },
  );
});

test("invariant: OpenAI Responses & OpenAI-compatible SSE streams are invariant to arbitrary & mid-UTF-8 byte boundaries", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(utf8DeltaArb, { minLength: 1, maxLength: 4 }),
      fc.array(fc.integer({ min: 0, max: 4096 }), { minLength: 1, maxLength: 40 }),
      fc.constantFrom("\n", "\r\n"),
      async (deltas, cuts, eol) => {
        const joined = deltas.join("");
        const oaiEvents = [
          ...deltas.map((delta) => ({ type: "response.output_text.delta", delta })),
          {
            type: "response.completed",
            response: {
              id: "resp_1",
              status: "completed",
              output: [
                {
                  type: "message",
                  id: "msg_1",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: joined }],
                },
              ],
              usage: { input_tokens: 5, output_tokens: 4, total_tokens: 9 },
            },
          },
        ];
        const oaiSse = oaiEvents.map((ev) => `data: ${JSON.stringify(ev)}${eol}${eol}`).join("");
        const wholeOai = await collect(streamOpenAIResponse(chunkedResponse(oaiSse, []), new AbortController().signal));
        const splitOai = await collect(
          streamOpenAIResponse(chunkedResponse(oaiSse, cuts, true), new AbortController().signal),
        );
        assert.deepEqual(splitOai, wholeOai);

        const compatEvents = [
          ...deltas.map((content) => ({ id: "cmpl_1", choices: [{ index: 0, delta: { content } }] })),
          {
            id: "cmpl_1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          },
        ];
        const compatSse = `${compatEvents.map((ev) => `data: ${JSON.stringify(ev)}${eol}${eol}`).join("")}data: [DONE]${eol}${eol}`;
        const opts = {
          signal: new AbortController().signal,
          providerName: "Compat",
          protocolError: (msg, o) => new Error(msg, o),
          finishReasonError: (reason) => new Error(`finish:${reason}`),
        };
        const wholeCompat = await collect(streamOpenAICompatibleResponse(chunkedResponse(compatSse, []), opts));
        const splitCompat = await collect(streamOpenAICompatibleResponse(chunkedResponse(compatSse, cuts, true), opts));
        assert.deepEqual(splitCompat, wholeCompat);
      },
    ),
    { numRuns: pbtRuns(80) },
  );
});

test("invariant: RetryingModel never retries after emitting any delta and respects Retry-After & maxDelayMs bounds", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 5 }),
      fc.integer({ min: 0, max: 500 }),
      fc.integer({ min: 0, max: 1000 }),
      fc.double({ min: 0, max: 1, noNaN: true }),
      fc.boolean(),
      fc.option(fc.integer({ min: 0, max: 2000 }), { nil: undefined }),
      async (maxAttempts, baseDelayMs, extraDelay, jitterRatio, emitsDeltaBeforeFail, retryAfterMs) => {
        const maxDelayMs = baseDelayMs + extraDelay;
        let attempts = 0;
        const observedDelays = [];
        const model = new RetryingModel(
          {
            async *stream() {
              attempts += 1;
              if (emitsDeltaBeforeFail) {
                yield { type: "text.delta", delta: "a" };
              }
              throw Object.assign(new Error("transient"), {
                status: 429,
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              });
            },
          },
          {
            maxAttempts,
            baseDelayMs,
            maxDelayMs,
            jitterRatio,
            random: () => 0.5,
            sleep: async (ms) => {
              observedDelays.push(ms);
            },
          },
        );

        await assert.rejects(collect(model.stream(request, { signal: new AbortController().signal })), /transient/);

        if (emitsDeltaBeforeFail) {
          assert.equal(attempts, 1, "RetryingModel must NEVER retry once a delta was emitted");
          assert.deepEqual(observedDelays, []);
        } else if (retryAfterMs !== undefined && retryAfterMs > maxDelayMs) {
          assert.equal(attempts, 1, "Retry-After exceeding maxDelayMs must fail immediately without sleeping");
          assert.deepEqual(observedDelays, []);
        } else {
          assert.equal(attempts, maxAttempts);
          assert.equal(observedDelays.length, attempts - 1);
          for (const delay of observedDelays) {
            assert.ok(delay >= 0 && delay <= maxDelayMs, `delay ${delay} out of [0, ${maxDelayMs}]`);
            if (retryAfterMs !== undefined) {
              assert.ok(delay >= retryAfterMs, `delay ${delay} violated Retry-After ${retryAfterMs}`);
            }
          }
        }
      },
    ),
    { numRuns: pbtRuns(120) },
  );
});
