import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemorySessionStore } from "@may/session";
import {
  InMemorySessionCatalog,
  MaybeCodeWorkspace,
  runMaybeCode,
  runTerminalUI,
} from "../dist/index.js";

test("terminal UI renders streams and drives tool approval", async (t) => {
  const workspace = await temporaryDirectory(t);
  const terminal = new FakeTerminal([
    "create a file",
    "/instructions",
    "/context",
    "/compact",
    "/compact history-reference",
    "/quit",
  ]);
  let modelCall = 0;
  const model = {
    limits: { contextWindowTokens: 10000, maxOutputTokens: 1000 },
    async *stream() {
      modelCall += 1;
      if (modelCall === 1) {
        yield { type: "reasoning.delta", delta: "checking" };
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [{ type: "reasoning", text: "checking" }],
            toolCalls: [{
              id: "write_one",
              name: "write",
              input: { path: "hello.txt", content: "hello" },
            }],
          },
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
        };
        return;
      }
      yield { type: "text.delta", delta: "done" };
      yield {
        type: "response.completed",
        message: assistantMessage("done"),
        usage: { inputTokens: 160, outputTokens: 5, totalTokens: 165 },
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });
  const initialSessionId = app.sessionId;

  await runTerminalUI(app, { terminal });

  assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "hello");
  assert.match(terminal.output, /\[thinking\] checking/);
  assert.match(terminal.output, /Change preview: hello\.txt \(created\)/);
  assert.match(terminal.output, /--- \/dev\/null\n\+\+\+ b\/hello\.txt/);
  assert.match(terminal.output, /\+hello/);
  assert.match(terminal.output, /Approval required for write/);
  assert.match(terminal.output, /Permission: allow-session/);
  assert.match(terminal.output, /✓ write: hello\.txt \(created, \+1 -0\)/);
  assert.match(terminal.output, /MaybeCode: done/);
  assert.match(
    terminal.output,
    /Instructions:\n  system: built-in\n  runtime: runtime\n  project: none/u,
  );
  assert.match(terminal.output, /Effective instructions:\n---\nYou are MaybeCode/u);
  assert.match(
    terminal.output,
    /Context:\n  messages: 4 \(system 0, user 1, assistant 2, tool 1\)/u,
  );
  assert.match(terminal.output, /estimated tokens: ~\d+ \(utf8-bytes\/4\)/u);
  assert.match(terminal.output, /effective usage: ~[\d,]+ \/ 10,000 \([\d.]+%\)/u);
  assert.match(terminal.output, /measurement: 160 measured \+ ~\d+ estimated tail/u);
  assert.match(terminal.output, /remaining: [\d,]+ tokens/u);
  assert.match(terminal.output, /input budget: 9,000 tokens \(1,000 reserved\)/u);
  assert.match(terminal.output, /compaction threshold: 9,000 tokens \(not reached\)/u);
  assert.match(
    terminal.output,
    /No context changes were eligible for prune\+summary-tail/u,
  );
  assert.match(
    terminal.output,
    /Pruning old tool results and summarizing context/u,
  );
  assert.match(
    terminal.output,
    /No context changes were eligible for history-reference/u,
  );
  assert.ok(terminal.closed);
  assert.ok(terminal.prompts.some((prompt) => prompt.includes("for [s]ession")));
  assert.equal(
    terminal.questions.find((question) =>
      question.prompt.includes("for [s]ession")
    ).history,
    false,
  );
  assert.equal(
    terminal.questions.find((question) =>
      question.prompt.includes("for [s]ession")
    ).suggestions,
    undefined,
  );
  assert.deepEqual(
    terminal.suggestionSamples.commands.map((suggestion) => suggestion.label),
    ["/resume", "/retry"],
  );
  assert.deepEqual(
    terminal.suggestionSamples.compaction.map((suggestion) => suggestion.label),
    ["history-reference"],
  );
  assert.ok(terminal.suggestionSamples.sessions.some((suggestion) =>
    suggestion.label === initialSessionId
  ));
  assert.equal(terminal.history.includes("s"), false);
});

test("Ctrl+C cancels an active run and keeps the UI usable", async () => {
  const terminal = new FakeTerminal(["wait", "/quit"]);
  const model = {
    async *stream(_request, { signal }) {
      setImmediate(() => terminal.interrupt());
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      yield {
        type: "response.completed",
        message: assistantMessage("unreachable"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store: new InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  await runTerminalUI(app, { terminal });

  assert.match(terminal.output, /Cancelling current operation/);
  assert.match(terminal.output, /Run cancelled: Interrupted/);
});

test("terminal UI shows automatic compaction failure and fallback progress", async () => {
  const terminal = new FakeTerminal(["x".repeat(2500), "/quit"]);
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: assistantMessage("continued"),
        };
      },
    },
    store: new InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
    contextBudget: {
      contextWindowTokens: 1000,
      compactTriggerRatio: 0.5,
    },
    autoCompactionStrategies: [
      {
        name: "simulated-native",
        compact() {
          throw new Error("simulated outage");
        },
      },
      {
        name: "tui-fallback",
        compact() {
          return [{
            role: "user",
            content: [{ type: "text", text: "Continue." }],
          }];
        },
      },
    ],
  });

  await runTerminalUI(app, { terminal });

  assert.match(
    terminal.output,
    /Automatic context compaction failed with simulated-native at ~[\d,]+ tokens: simulated outage\. Trying the next strategy\./u,
  );
  assert.match(
    terminal.output,
    /Context automatically compacted with tui-fallback/u,
  );
  assert.match(terminal.output, /MaybeCode: continued/u);
});

test("terminal UI accepts multiline input and renders status", async () => {
  let request;
  const terminal = new FakeTerminal([
    "first line\\",
    "second line",
    "/status",
    "/hel",
    "/quit",
  ]);
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model: {
      limits: { contextWindowTokens: 10000, maxOutputTokens: 1000 },
      async *stream(value) {
        request = value;
        yield {
          type: "response.completed",
          message: assistantMessage("received"),
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 },
        };
      },
    },
    modelInfo: { provider: "deepseek", model: "deepseek-chat" },
    store: new InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  await runTerminalUI(app, { terminal });

  const user = request.messages.find((message) => message.role === "user");
  assert.equal(user.content[0].text, "first line\nsecond line");
  assert.ok(terminal.prompts.includes("... "));
  assert.ok(terminal.history.includes("first line\nsecond line"));
  assert.match(terminal.output, /Model: deepseek\/deepseek-chat/u);
  assert.match(terminal.output, /Status:\n  model: deepseek\/deepseek-chat/u);
  assert.match(terminal.output, /  session: session_/u);
  assert.match(terminal.output, /  workspace: /u);
  assert.match(terminal.output, /  context: ~[\d,]+ \/ 10,000 tokens/u);
  assert.match(terminal.output, /Multiline\s+End a line with \\ to continue/u);
});

test("terminal UI retries the latest failed run without duplicating input", async () => {
  let modelCalls = 0;
  const terminal = new FakeTerminal(["do work", "/retry", "/quit"]);
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model: {
      async *stream() {
        modelCalls += 1;
        if (modelCalls === 1) throw new Error("temporary outage");
        yield {
          type: "retrying",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 500,
          error: { name: "Error", message: "rate limited" },
        };
        yield {
          type: "response.completed",
          message: assistantMessage("recovered"),
        };
      },
    },
    store: new InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  await runTerminalUI(app, { terminal });

  assert.equal(modelCalls, 2);
  assert.match(terminal.output, /Run failed: temporary outage/u);
  assert.match(terminal.output, /Retrying the latest failed run/u);
  assert.match(
    terminal.output,
    /Model request failed: rate limited\. Retrying in 500ms \(attempt 2\/3\)/u,
  );
  assert.match(terminal.output, /MaybeCode: recovered/u);
});

test("resume picker uses contextual keys to rename, delete, and resume", async () => {
  const store = new InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model: {
      async *stream() {
        yield { type: "response.completed", message: assistantMessage("done") };
      },
    },
    store,
    catalog,
    autoResume: false,
  });
  const firstId = app.sessionId;
  await (await app.submit({ input: "first task" })).result;
  const secondId = await app.newSession();
  await (await app.submit({ input: "second task" })).result;
  await app.newSession();
  const initialSessions = await app.listSessions();
  const secondIndex = initialSessions.findIndex((session) =>
    session.id === secondId
  );
  const afterDelete = initialSessions.filter((session) => session.id !== secondId);
  const firstIndexAfterDelete = afterDelete.findIndex((session) =>
    session.id === firstId
  );

  const keys = [
    key("home"),
    ...Array.from({ length: secondIndex }, () => key("down")),
    key("r", { text: "r" }),
    key("u", { ctrl: true }),
    ...textKeys("Renamed session"),
    key("enter"),
    key("d", { text: "d" }),
    key("y", { text: "y" }),
    key("home"),
    ...Array.from({ length: firstIndexAfterDelete }, () => key("down")),
    key("enter"),
  ];
  const terminal = new FakeTerminal(["/resume", "/quit"], keys);

  await runTerminalUI(app, { terminal });

  assert.equal(app.sessionId, firstId);
  assert.equal((await store.read(secondId)).length, 0);
  assert.ok(terminal.frames.some((frame) =>
    frame.includes("Renamed session to Renamed session")
  ));
  assert.ok(terminal.frames.some((frame) => frame.includes("Deleted Renamed session")));
  assert.match(terminal.output, new RegExp(`Resumed session ${firstId}`));
});

test("CLI returns usage errors without opening an application", async () => {
  const terminal = new FakeTerminal([]);
  let opened = false;
  const exitCode = await runMaybeCode(["--continue", "--resume", "one"], {
    terminal,
    async open() {
      opened = true;
      throw new Error("unreachable");
    },
  });

  assert.equal(exitCode, 2);
  assert.equal(opened, false);
  assert.match(terminal.output, /cannot be used together/);
  assert.ok(terminal.closed);
});

class FakeTerminal {
  colors = false;
  interactive = false;
  output = "";
  prompts = [];
  questions = [];
  history = [];
  suggestionSamples;
  closed = false;
  frames = [];
  #answers;
  #keys;
  #interrupt;

  constructor(answers, keys = []) {
    this.#answers = [...answers];
    this.#keys = [...keys];
    this.interactive = keys.length > 0;
  }

  async question(prompt, { signal, history, suggestions } = {}) {
    this.prompts.push(prompt);
    this.questions.push({ prompt, history, suggestions });
    if (suggestions !== undefined && this.suggestionSamples === undefined) {
      this.suggestionSamples = {
        commands: await suggestions("/re"),
        compaction: await suggestions("/compact h"),
        sessions: await suggestions("/resume session_"),
      };
    }
    if (signal?.aborted) throw abortError();
    if (prompt.includes("[a]llow once")) return "s";
    const answer = this.#answers.shift();
    if (answer === undefined) throw new Error(`No answer for prompt: ${prompt}`);
    return answer;
  }

  addHistory(value) {
    this.history.unshift(value);
  }

  async readKey() {
    const stroke = this.#keys.shift();
    if (stroke === undefined) throw new Error("No key available");
    return stroke;
  }

  renderView(text) {
    this.frames.push(text);
  }

  closeView() {}

  write(text) {
    this.output += text;
  }

  onInterrupt(listener) {
    this.#interrupt = listener;
    return () => {
      this.#interrupt = undefined;
    };
  }

  interrupt() {
    this.#interrupt?.();
  }

  close() {
    this.closed = true;
  }
}

function key(name, options = {}) {
  return {
    key: name,
    ctrl: options.ctrl ?? false,
    alt: options.alt ?? false,
    shift: options.shift ?? false,
    meta: options.meta ?? false,
    ...(options.text === undefined ? {} : { text: options.text }),
  };
}

function textKeys(value) {
  return [...value].map((text) =>
    key(text === " " ? "space" : text.toLowerCase(), {
      text,
      shift: text.toLowerCase() !== text,
    })
  );
}

function abortError() {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-tui-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
