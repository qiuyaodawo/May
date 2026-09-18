import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, Text } from "../dist/index.js";
import { TranscriptStore } from "../dist/agent/transcript.js";

test("keeps a resolved row at the viewport top until manual scrolling and restores end following", () => {
  let lines = Array.from({ length: 20 }, (_, index) => `line-${index}`);
  let start = 18;
  const scroll = new ScrollView(new Text(() => lines.join("\n")), { followEnd: true });
  const size = { width: 30, height: 5 };
  scroll.render(size);
  scroll.scrollToAnchor(() => ({ start, end: start }));
  assert.deepEqual(scroll.render(size).lines, ["line-18", "line-19"]);
  lines = ["added-before", ...lines, "added-after"];
  start += 1;
  assert.deepEqual(scroll.render(size).lines, ["line-18", "line-19", "added-after"]);
  scroll.scrollBy(-1);
  assert.equal(scroll.render(size).lines[0], "line-17");
  assert.equal(scroll.render(size).lines[0], "line-17");
  scroll.scrollToEnd();
  lines.push("latest");
  assert.equal(scroll.render(size).lines.at(-1), "latest");
});

test("completion retains streamed reasoning and new input clears the final reply", () => {
  const store = new TranscriptStore();
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, seq: 1, type: "run.started" });
  store.applyMayEvent({ ...base, seq: 2, type: "model.reasoning.delta", delta: "streamed thinking" });
  const message = { role: "assistant", content: [{ type: "text", text: "final reply" }] };
  store.applyMayEvent({ ...base, seq: 3, type: "model.completed", message, contextMessageCount: 2 });
  assert.equal(store.latestReply, undefined);
  store.applyMayEvent({ ...base, seq: 4, type: "run.completed", result: {
    runId: "run-1", steps: 1, modelCalls: 1, toolCalls: 0, message,
  } });
  assert.equal(store.latestReply.text, "final reply");
  assert.equal(store.latestReply.reasoning, "streamed thinking");
  store.appendUser("next question");
  assert.equal(store.latestReply, undefined);
});
