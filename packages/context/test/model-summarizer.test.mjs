import assert from "node:assert/strict";
import test from "node:test";

import { ModelProtocolError, RunCancelledError } from "@may/core";
import {
  createModelContextSummarizer,
} from "@may/context/model-summarizer";

const options = {
  instructions: "Summarize facts for a later request.",
  requestText: "Return the summary now.",
};

test("creates a parameterized, tool-free model summary", async () => {
  let captured;
  const controller = new AbortController();
  const summarizer = createModelContextSummarizer({
    async *stream(request, streamOptions) {
      captured = { request, streamOptions };
      yield { type: "reasoning.delta", delta: "thinking" };
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", text: "not returned" },
            { type: "text", text: "  first" },
            { type: "text", text: " summary  " },
          ],
        },
      };
    },
  }, options);

  const result = await summarizer.summarize({
    messages: [userMessage("source conversation")],
    signal: controller.signal,
  });

  assert.equal(result, "first summary");
  assert.equal(captured.streamOptions.signal, controller.signal);
  assert.deepEqual(captured.request.tools, []);
  assert.deepEqual(captured.request.messages, [
    userMessage(options.instructions, "system"),
    userMessage("source conversation"),
    userMessage(options.requestText),
  ]);
});

test("rejects malformed summary responses", async (t) => {
  await t.test("missing completion", async () => {
    await assert.rejects(
      summarizeWith(async function* () {
        yield { type: "text.delta", delta: "unfinished" };
      }),
      ModelProtocolError,
    );
  });

  await t.test("multiple completions", async () => {
    await assert.rejects(
      summarizeWith(async function* () {
        yield completion("one");
        yield completion("two");
      }),
      /more than one completed response/u,
    );
  });

  await t.test("tool call", async () => {
    await assert.rejects(
      summarizeWith(async function* () {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "summary" }],
            toolCalls: [{ id: "one", name: "read", input: {} }],
          },
        };
      }),
      /attempted to call a tool/u,
    );
  });

  await t.test("empty text", async () => {
    await assert.rejects(
      summarizeWith(async function* () {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [{ type: "reasoning", text: "only reasoning" }],
          },
        };
      }),
      /returned no text/u,
    );
  });
});

test("turns an aborted summary into RunCancelledError", async () => {
  const controller = new AbortController();
  controller.abort("stop summary");
  let called = false;
  const summarizer = createModelContextSummarizer({
    async *stream() {
      called = true;
    },
  }, options);

  await assert.rejects(
    summarizer.summarize({ messages: [], signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof RunCancelledError);
      assert.equal(error.message, "stop summary");
      return true;
    },
  );
  assert.equal(called, false);
});

async function summarizeWith(stream) {
  return createModelContextSummarizer({ stream }, options)
    .summarize({ messages: [] });
}

function completion(text) {
  return {
    type: "response.completed",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

function userMessage(text, role = "user") {
  return { role, content: [{ type: "text", text }] };
}
