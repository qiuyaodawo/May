import assert from "node:assert/strict";
import test from "node:test";

import { ModelProtocolError, RunCancelledError } from "@may/core";

import { createModelContextSummarizer } from "../dist/index.js";

test("summarizes messages with a tool-free model request", async () => {
  let captured;
  const controller = new AbortController();
  const summarizer = createModelContextSummarizer({
    async *stream(request, options) {
      captured = { request, options };
      yield { type: "reasoning.delta", delta: "thinking" };
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "  concise summary  " },
          ],
        },
      };
    },
  });

  const result = await summarizer.summarize({
    messages: [userMessage("old request")],
    signal: controller.signal,
  });

  assert.equal(result, "concise summary");
  assert.equal(captured.options.signal, controller.signal);
  assert.deepEqual(captured.request.tools, []);
  assert.equal(captured.request.messages[0].role, "system");
  assert.equal(captured.request.messages[1].content[0].text, "old request");
  assert.match(
    captured.request.messages.at(-1).content[0].text,
    /continuation summary/u,
  );
});

test("rejects malformed summary model responses", async (t) => {
  await t.test("missing completion", async () => {
    const summarizer = createModelContextSummarizer({
      async *stream() {
        yield { type: "text.delta", delta: "unfinished" };
      },
    });
    await assert.rejects(
      summarizer.summarize({ messages: [] }),
      ModelProtocolError,
    );
  });

  await t.test("tool call", async () => {
    const summarizer = createModelContextSummarizer({
      async *stream() {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{ id: "one", name: "read", input: {} }],
          },
        };
      },
    });
    await assert.rejects(
      summarizer.summarize({ messages: [] }),
      /attempted to call a tool/u,
    );
  });

  await t.test("cancellation", async () => {
    const controller = new AbortController();
    const summarizer = createModelContextSummarizer({
      async *stream(_request, { signal }) {
        controller.abort("stop summary");
        signal.throwIfAborted();
      },
    });
    await assert.rejects(
      summarizer.summarize({ messages: [], signal: controller.signal }),
      RunCancelledError,
    );
  });
});

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
