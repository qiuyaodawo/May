import assert from "node:assert/strict";
import test from "node:test";
import { imageSource } from "../../../packages/media/test/fixture.mjs";
import { mediaHistory } from "../dist/media-history.js";
import { TranscriptStore } from "@may/tui";

test("原始图片在 assistant 和 Run 历史中保持一致", async () => {
  const source = await imageSource();
  const message = { role: "assistant", content: [], modelState: { type: "openai.responses.output.v1", data: { items: [{ type: "image_generation_call", result: source.data, output_format: "png" }] } } };
  const base = { sessionId: "image", runId: "run", timestamp: 1 };
  const events = [{ ...base, seq: 1, type: "assistant.completed", step: 1, message }, { ...base, seq: 2, type: "run.completed", result: { steps: 1, message } }];
  const history = mediaHistory(events);
  assert.equal(message.content.length, 0);
  assert.equal(history[0].message.content[0].type, "image");
  assert.deepEqual(history[0].message.content, history[1].result.message.content);
  assert.deepEqual(mediaHistory(history), history);
  const store = new TranscriptStore(); store.loadHistory(history);
  assert.equal(store.latestReply.content[0].type, "image");
});
