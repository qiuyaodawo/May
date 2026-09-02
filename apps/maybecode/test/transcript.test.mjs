import assert from "node:assert/strict";
import test from "node:test";
import {
  MaybeCodePrototypeView,
  TranscriptStore,
  TranscriptView,
} from "../dist/index.js";
import { ScrollView } from "@may/tui";

test("projects streaming events into stable, terminal-safe transcript items", () => {
  const store = new TranscriptStore();
  const base = { runId: "run-1", step: 1, timestamp: 1 };
  store.applyMayEvent({ ...base, type: "model.started", seq: 1 });
  store.applyMayEvent({
    ...base,
    type: "model.reasoning.delta",
    delta: "think",
    seq: 2,
  });
  store.applyMayEvent({
    ...base,
    type: "model.text.delta",
    delta: "\x1b[2Jhello",
    seq: 3,
  });
  store.applyMayEvent({
    ...base,
    type: "model.completed",
    seq: 4,
    contextMessageCount: 2,
    message: {
      role: "assistant",
      content: [
        { type: "reasoning", text: "think" },
        { type: "text", text: "\x1b[2Jhello" },
      ],
    },
  });

  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].status, "completed");
  const rendered = new TranscriptView(store).render({ width: 40, height: 8 });
  assert.match(rendered.lines.join("\n"), /␛\[2Jhello/u);
  assert.doesNotMatch(rendered.lines.join("\n"), /\u001b\[2J/u);
});

test("keeps the newest transcript rows after the scroll buffer limit", () => {
  const store = new TranscriptStore();
  store.appendUser(Array.from({ length: 10_050 }, (_, index) =>
    `old-${index}`
  ).join("\n"));
  store.appendUser("LATEST-MESSAGE");
  const scroll = new ScrollView(new TranscriptView(store), { followEnd: true });

  const rendered = scroll.render({ width: 80, height: 6 }).lines.join("\n");
  assert.match(rendered, /LATEST-MESSAGE/u);
  assert.doesNotMatch(rendered, /old-0(?:\D|$)/u);

  const single = new TranscriptStore();
  single.appendUser(Array.from({ length: 10_050 }, (_, index) =>
    `single-${index}`
  ).join("\n"));
  const singleRendered = new ScrollView(new TranscriptView(single), {
    followEnd: true,
  }).render({ width: 80, height: 4 }).lines.join("\n");
  assert.match(singleRendered, /single-10049/u);
  assert.doesNotMatch(singleRendered, /single-0(?:\D|$)/u);
});

test("does not display input that the controller rejected", async () => {
  const store = new TranscriptStore();
  const view = new MaybeCodePrototypeView({
    store,
    workspace: "workspace",
    async onSubmit() {
      throw new Error("busy");
    },
  });
  for (const text of "hello") {
    view.handleKey({
      key: text,
      text,
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  }
  view.handleKey({
    key: "enter",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.items.some((item) => item.kind === "user"), false);
  assert.match(view.render({ width: 80, height: 20 }).lines.join("\n"), /busy/u);
  view.dispose();
});

test("collapses file diffs and reveals them through the details toggle", () => {
  const store = new TranscriptStore();
  store.applyMayEvent({
    type: "tool.started",
    runId: "run-1",
    step: 1,
    seq: 1,
    timestamp: 1,
    call: { id: "edit-1", name: "edit", input: { path: "a.ts" } },
  });
  store.appendChangePreview(
    "run-1",
    1,
    "edit-1",
    {
      status: "ready",
      tool: "edit",
      path: "a.ts",
      kind: "update",
      additions: 1,
      deletions: 1,
      diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new",
    },
  );

  const view = new TranscriptView(store);
  assert.doesNotMatch(
    view.render({ width: 80, height: 20 }).lines.join("\n"),
    /\+new/u,
  );
  view.setFocused(true);
  view.render({ width: 80, height: 20 });
  view.handleKey({
    key: "enter",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  assert.match(
    view.render({ width: 80, height: 20 }).lines.join("\n"),
    /\+new/u,
  );

  const restored = new TranscriptStore();
  restored.loadHistory([
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
      data: store.items[0].preview,
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
  assert.equal(restored.items[0].preview.kind, "update");
  assert.match(
    new TranscriptView(restored, { showToolDetails: true })
      .render({ width: 80, height: 20 }).lines.join("\n"),
    /\+new/u,
  );
});

test("routes approval shortcuts through the retained modal", async () => {
  const view = new MaybeCodePrototypeView({
    store: new TranscriptStore(),
    workspace: "workspace",
    onSubmit() {},
  });
  const decision = view.requestApproval({
    id: "approval-1",
    createdAt: 1,
    grantKey: "shell:command",
    tool: { name: "shell", description: "Run shell", inputSchema: {} },
    input: { command: "echo safe" },
    context: {
      runId: "run-1",
      step: 1,
      toolCallId: "tool-1",
      idempotencyKey: "key",
      signal: new AbortController().signal,
      report() {},
    },
  });
  assert.match(
    view.render({ width: 80, height: 20 }).lines.join("\n"),
    /Allow matching calls for this session/u,
  );
  view.handleKey({
    key: "s",
    text: "s",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  assert.equal(await decision, "allow-session");
  view.dispose();
});

test("completes slash commands and selects sessions in retained dialogs", async () => {
  const submitted = [];
  const view = new MaybeCodePrototypeView({
    store: new TranscriptStore(),
    workspace: "workspace",
    suggestions: async (input) => input.startsWith("/res")
      ? [{ value: "/resume", label: "/resume", description: "Resume" }]
      : [],
    onSubmit(value) {
      submitted.push(value);
    },
  });
  for (const text of "/res") {
    view.handleKey({
      key: text,
      text,
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  view.handleKey({
    key: "enter",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["/resume"]);

  for (const text of "/det") {
    view.handleKey({
      key: text,
      text,
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  view.handleKey({
    key: "enter",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, ["/resume"]);
  assert.match(
    view.render({ width: 80, height: 20 }).lines.join("\n"),
    /Tool details shown/u,
  );
  view.handleKey({
    key: "up",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  assert.match(
    view.render({ width: 80, height: 20 }).lines.join("\n"),
    /\/details/u,
  );

  const selection = view.requestSessionAction([
    {
      id: "current",
      workspace: "workspace",
      createdAt: 1,
      lastUsedAt: 2,
      turnCount: 1,
      title: "Current",
    },
    {
      id: "older",
      workspace: "workspace",
      createdAt: 1,
      lastUsedAt: 1,
      turnCount: 2,
      title: "Older session",
    },
  ], "current");
  view.handleKey({
    key: "down",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  view.handleKey({
    key: "enter",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  assert.deepEqual(await selection, { type: "resume", sessionId: "older" });

  const modelAction = view.requestModelAction([
    {
      name: "first",
      provider: "local",
      adapter: "openai-responses",
      model: "first-model",
      isDefault: true,
    },
    {
      name: "second",
      provider: "local",
      adapter: "openai-responses",
      model: "second-model",
      isDefault: false,
    },
  ], "first");
  view.handleKey({
    key: "down",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  view.handleKey({
    key: "d",
    text: "d",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
  });
  assert.deepEqual(await modelAction, {
    type: "set-default",
    profile: "second",
  });
  view.dispose();
});
