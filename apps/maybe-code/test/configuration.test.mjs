import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  openConfiguredMaybeCode,
  parseMaybeCodeArgs,
  selectMaybeCodeModel,
} from "../dist/index.js";

test("parses MaybeCode startup options", () => {
  assert.deepEqual(
    parseMaybeCodeArgs([
      "--config",
      "custom.json",
      "--model",
      "reasoner",
      "--session",
      "abc",
      ".",
    ]),
    {
      type: "start",
      workspace: ".",
      configPath: "custom.json",
      model: "reasoner",
      sessionId: "abc",
      autoResume: true,
    },
  );
  assert.equal(parseMaybeCodeArgs(["--new"]).autoResume, false);
  assert.throws(
    () => parseMaybeCodeArgs(["--new", "--session", "abc"]),
    /cannot be used together/,
  );
});

test("selects the default model profile", () => {
  const selection = selectMaybeCodeModel({
    path: "config.json",
    providers: { deepseek: { apiKey: "key" } },
    models: {
      reasoner: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        options: { maxTokens: 100 },
      },
    },
    defaultModel: "reasoner",
  });

  assert.equal(selection.provider, "deepseek");
  assert.equal(selection.model, "deepseek-reasoner");
  assert.deepEqual(selection.options, { maxTokens: 100 });
});

test("opens configured MaybeCode with injected model creation", async (t) => {
  const directory = await temporaryDirectory(t);
  let selected;
  const app = await openConfiguredMaybeCode(
    {
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
    },
    {
      async loadConfig() {
        return {
          path: "config.json",
          providers: {
            deepseek: { apiKey: "test", model: "deepseek-chat" },
          },
          models: {},
        };
      },
      createModel(selection) {
        selected = selection;
        return {
          async *stream() {
            yield {
              type: "response.completed",
              message: assistantMessage("ok"),
            };
          },
        };
      },
    },
  );

  assert.equal(selected.model, "deepseek-chat");
  assert.equal(
    (await (await app.submit({ input: "hello" })).result).message.content[0]
      .text,
    "ok",
  );
  await app.close();
});

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybe-code-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
