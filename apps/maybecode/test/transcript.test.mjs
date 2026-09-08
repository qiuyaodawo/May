import assert from "node:assert/strict";
import test from "node:test";
import {
  MaybeCodePrototypeView,
  TranscriptStore,
  TranscriptView,
} from "../dist/index.js";
import { ScrollView } from "@may/tui";

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
