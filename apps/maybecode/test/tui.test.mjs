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
    "/compact summary-tail",
    "/sessions",
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
  assert.match(terminal.output, /Instructions:\n  system: built-in\n  project: none/);
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
    /No context changes were eligible for prune-old-tool-results/u,
  );
  assert.match(terminal.output, /Summarizing older context/u);
  assert.match(
    terminal.output,
    /No context changes were eligible for summary-tail/u,
  );
  assert.match(terminal.output, /Sessions:/);
  assert.ok(terminal.closed);
  assert.ok(terminal.prompts.some((prompt) => prompt.includes("allow [s]ession")));
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

test("CLI returns usage errors without opening an application", async () => {
  const terminal = new FakeTerminal([]);
  let opened = false;
  const exitCode = await runMaybeCode(["--new", "--session", "one"], {
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
  output = "";
  prompts = [];
  closed = false;
  #answers;
  #interrupt;

  constructor(answers) {
    this.#answers = [...answers];
  }

  async question(prompt, { signal } = {}) {
    this.prompts.push(prompt);
    if (signal?.aborted) throw abortError();
    if (prompt.includes("[a]llow once")) return "s";
    const answer = this.#answers.shift();
    if (answer === undefined) throw new Error(`No answer for prompt: ${prompt}`);
    return answer;
  }

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
