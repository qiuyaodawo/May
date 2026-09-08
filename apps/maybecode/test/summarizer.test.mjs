import assert from "node:assert/strict";
import test from "node:test";

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

function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }] };
}
