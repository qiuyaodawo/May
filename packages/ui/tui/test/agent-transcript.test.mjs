import assert from "node:assert/strict";
import test from "node:test";
import {
  TranscriptStore,
  TranscriptView,
} from "@may/tui/transcript";

test("projects live May and permission events into a terminal-safe transcript", () => {
  const store = new TranscriptStore();
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, type: "model.started", seq: 1 });
  store.applyMayEvent({
    ...base,
    type: "model.text.delta",
    delta: "\x1b[2Jhello",
    seq: 2,
  });
  store.applyMayEvent({
    ...base,
    type: "model.completed",
    seq: 3,
    contextMessageCount: 2,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "\x1b[2Jhello" }],
    },
  });
  store.applyPermissionEvent({
    type: "approval.requested",
    seq: 1,
    timestamp: 2,
    request: {
      id: "approval-1",
      createdAt: 2,
      tool: { name: "shell", description: "Run shell", inputSchema: {} },
      input: { command: "echo safe" },
      context: {
        runId: "run-1",
        step: 1,
        toolCallId: "call-1",
        idempotencyKey: "key",
        signal: new AbortController().signal,
        report() {},
      },
    },
  });

  assert.deepEqual(store.items.map((item) => item.kind), ["assistant", "approval"]);
  const rendered = new TranscriptView(store, { assistantLabel: "Agent" })
    .render({ width: 60, height: 10 }).lines.join("\n");
  assert.match(rendered, /Agent/u);
  assert.match(rendered, /␛\[2Jhello/u);
  assert.match(rendered, /Approval required for/u);
  assert.doesNotMatch(rendered, /\u001b\[2J/u);
});

test("restores coding change previews and renders their diff on demand", () => {
  const preview = {
    status: "ready",
    tool: "edit",
    path: "a.ts",
    kind: "update",
    additions: 1,
    deletions: 1,
    diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
  };
  const store = new TranscriptStore();
  store.loadHistory([
    {
      type: "session.created",
      sessionId: "session-1",
      seq: 1,
      timestamp: 1,
    },
    {
      type: "tool.presentation",
      sessionId: "session-1",
      seq: 2,
      timestamp: 2,
      runId: "run-1",
      step: 1,
      toolCallId: "edit-1",
      kind: "maybecode.change-preview",
      version: 1,
      data: preview,
    },
    {
      type: "tool.completed",
      sessionId: "session-1",
      seq: 3,
      timestamp: 3,
      runId: "run-1",
      step: 1,
      call: { id: "edit-1", name: "edit", input: { path: "a.ts" } },
      output: { path: "a.ts", changed: true },
    },
  ]);

  assert.equal(store.sessionId, "session-1");
  assert.equal(store.items[0].preview.kind, "update");
  assert.match(
    new TranscriptView(store, { showToolDetails: true })
      .render({ width: 80, height: 20 }).lines.join("\n"),
    /\+new/u,
  );
});

test("lets applications append product notices and change previews explicitly", () => {
  const store = new TranscriptStore();
  store.appendNotice("info", "Model switched");
  store.appendChangePreview("run-1", 1, "write-1", {
    status: "unavailable",
    tool: "write",
    path: "a.ts",
    reason: "not readable",
  });

  assert.deepEqual(store.items.map((item) => item.kind), ["notice", "tool"]);
  assert.equal(store.items[1].preview.status, "unavailable");
});
