import assert from "node:assert/strict";
import test from "node:test";
import { parseCompletedOpenAIResponse, openAIResponseContent } from "../dist/stream.js";
import { imageSource } from "../../../media/test/fixture.mjs";

test("Responses 图片转换保留图文顺序及 provider state", async () => {
  const source = await imageSource();
  const output = [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "before" }] },
    { type: "image_generation_call", output_format: "png", result: source.data },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "after" }] },
  ];
  const { message } = parseCompletedOpenAIResponse({ output });
  assert.deepEqual(message.content.map(part => part.type), ["text", "image", "text"]);
  assert.deepEqual(message.content[1].source, source);
  assert.equal(message.modelState.data.items, output);
  assert.deepEqual(openAIResponseContent({ ...message, content: [{ type: "text", text: "beforeafter" }] }), message.content);
  assert.throws(() => parseCompletedOpenAIResponse({ output: [{ type: "image_generation_call", result: source.data, output_format: "svg" }] }), /format/);
});
