import assert from "node:assert/strict";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { assistantMessage, temporaryDirectory } from "./fixtures/application.mjs";

import { InMemoryContext } from "@sortedyuan/may/core";

import { openConfiguredMaybeCode } from "../dist/index.js";
import { parseMaybeCodeArgs } from "../dist/args.js";
import { resolveMaybeCodeObservability } from "../dist/configured-resolvers.js";

test("parses MaybeCode startup options", () => {
  assert.deepEqual(parseMaybeCodeArgs(["--config", "custom.json", "--model", "reasoner", "--resume", "abc", "."]), {
    type: "start",
    workspace: ".",
    configPath: "custom.json",
    model: "reasoner",
    sessionId: "abc",
    autoResume: false,
    ui: "retained",
  });
  assert.equal(parseMaybeCodeArgs(["--ui", "retained"]).ui, "retained");
  assert.throws(() => parseMaybeCodeArgs(["--ui", "classic"]), /--ui must be "retained" or "web"/);
  assert.equal(parseMaybeCodeArgs([]).autoResume, false);
  assert.equal(parseMaybeCodeArgs(["--continue"]).autoResume, true);
  assert.throws(() => parseMaybeCodeArgs(["--continue", "--resume", "abc"]), /cannot be used together/);
  assert.throws(() => parseMaybeCodeArgs(["--config", "--model", "chat"]), /--config requires a value/);
});

test("opens configured MaybeCode with injected model creation", async (t) => {
  const directory = await temporaryDirectory(t);
  const configDirectory = join(directory, "config");
  const instructionsDirectory = join(configDirectory, "instructions", "maybecode");
  await mkdir(instructionsDirectory, { recursive: true });
  await writeFile(join(instructionsDirectory, "system.md"), "custom system");
  await mkdir(join(directory, ".git"));
  await writeFile(join(directory, "AGENTS.md"), "project rules");
  let selected;
  let request;
  let contextOptions;
  const app = await openConfiguredMaybeCode(
    {
      git: false,
      skills: false,
      workspace: directory,
      dataDirectory: join(directory, "data"),
      autoResume: false,
      contextFactory: {
        create(options) {
          contextOptions = options;
          const context = new InMemoryContext({
            instructions: options.instructions,
            messages: [...(options.messages ?? [])],
            metadata: { ...options.metadata },
          });
          return { context };
        },
      },
    },
    {
      async loadConfig() {
        return {
          path: join(configDirectory, "config.json"),
          providers: {
            deepseek: {
              adapter: "deepseek-chat",
              apiKey: "test",
              baseURL: "http://127.0.0.1:1",
            },
          },
          models: {
            chat: {
              provider: "deepseek",
              model: "deepseek-chat",
              contextWindowTokens: 64000,
              maxOutputTokens: 4096,
            },
          },
          defaultModel: "chat",
          apps: {
            maybecode: {
              requestRecording: "off",
              instructionsDirectory: "instructions/maybecode",
            },
          },
        };
      },
      createModel(selection) {
        selected = selection;
        return {
          async *stream(value) {
            request = value;
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
  assert.deepEqual(app.application.modelInfo, {
    profile: "chat",
    provider: "deepseek",
    adapter: "deepseek-chat",
    model: "deepseek-chat",
    searchStatus: "Search disabled",
  });
  assert.equal((await (await app.submit({ input: "hello" })).result).message.content[0].text, "ok");
  assert.match(request.messages[0].content[0].text, /^custom system\n\n# Current environment\n\n/u);
  assert.match(
    request.messages[0].content[0].text,
    /\n\n# Project instructions\n\nSource: [^\n]+\n\nproject rules\n\n# Tool use\n\n/u,
  );
  assert.ok(request.messages[0].content[0].text.includes(`Source: ${await realpath(join(directory, "AGENTS.md"))}`));
  assert.equal(app.application.instructions.system.source.type, "file");
  assert.equal(app.application.instructions.runtime.source.type, "runtime");
  assert.equal(app.application.instructions.project.source.type, "file");
  assert.deepEqual(contextOptions.metadata, { workspace: await realpath(directory) });
  assert.deepEqual(contextOptions.budget, {
    contextWindowTokens: 64000,
    outputReserveTokens: 4096,
    compactTriggerRatio: 0.9,
  });
  assert.deepEqual(
    contextOptions.autoCompactionStrategies.map((strategy) => strategy.name),
    ["prune-old-tool-results", "summary-tail"],
  );
  await app.close();
});

test("writes configured content-free traces and flushes them on close", async (t) => {
  const directory = await temporaryDirectory(t);
  const dataDirectory = join(directory, "data");
  const traceDirectory = join(dataDirectory, "telemetry");
  const app = await openConfiguredMaybeCode(
    { git: false, workspace: directory, dataDirectory, autoResume: false },
    {
      async loadConfig() {
        return {
          path: join(directory, "config.json"),
          providers: {
            local: { adapter: "test", apiKey: "do-not-capture" },
          },
          models: {
            chat: { provider: "local", model: "test-model" },
          },
          defaultModel: "chat",
          apps: {
            maybecode: {
              requestRecording: "off",
              retry: false,
              observability: {
                enabled: true,
                exporter: "file",
                file: "telemetry/traces.jsonl",
                samplingRatio: 1,
                batch: { scheduledDelayMs: 60_000 },
              },
            },
          },
        };
      },
      createModel() {
        return {
          async *stream() {
            yield {
              type: "response.completed",
              message: assistantMessage("private answer"),
            };
          },
        };
      },
    },
  );

  await (
    await app.submit({ input: "private prompt" })
  ).result;
  const sessionId = app.sessionId;
  await app.close();

  const traceFiles = (await readdir(traceDirectory)).filter((name) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name));
  assert.equal(traceFiles.length, 1);
  const content = await readFile(join(traceDirectory, traceFiles[0]), "utf8");
  const spans = content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const run = spans.find((span) => span.name === "may.run");
  assert.ok(run);
  assert.equal(run.attributes["service.name"], "maybecode");
  assert.equal(run.attributes["may.agent.name"], "maybecode");
  assert.equal(run.attributes["may.model.profile"], "chat");
  assert.equal(run.attributes["may.session.id"], sessionId);
  assert.doesNotMatch(content, /private prompt|private answer|do-not-capture/u);
});

test("resolves and validates MaybeCode observability configuration", () => {
  const base = { path: "config.json", providers: {}, models: {} };
  assert.equal(resolveMaybeCodeObservability(base), false);
  assert.equal(
    resolveMaybeCodeObservability({
      ...base,
      apps: { maybecode: { observability: { enabled: false } } },
    }),
    false,
  );
  assert.deepEqual(
    resolveMaybeCodeObservability({
      ...base,
      apps: {
        maybecode: {
          observability: {
            file: "trace/output.jsonl",
            samplingRatio: 0.25,
            retentionDays: 30,
            batch: { maxQueueSize: 32, maxExportBatchSize: 8 },
          },
        },
      },
    }),
    {
      file: "trace/output.jsonl",
      samplingRatio: 0.25,
      retentionDays: 30,
      maxQueueSize: 32,
      maxExportBatchSize: 8,
    },
  );
  assert.throws(
    () =>
      resolveMaybeCodeObservability({
        ...base,
        apps: {
          maybecode: {
            observability: {
              batch: { maxQueueSize: 8, maxExportBatchSize: 9 },
            },
          },
        },
      }),
    /maxExportBatchSize cannot exceed maxQueueSize/u,
  );
  assert.throws(
    () =>
      resolveMaybeCodeObservability({
        ...base,
        apps: { maybecode: { observability: { destination: "somewhere" } } },
      }),
    /observability\.destination is not supported/u,
  );
});

test("explains Windows drive-relative paths mangled by Git Bash", { skip: process.platform !== "win32" }, async () => {
  for (const workspace of ["E:codeept", "E:"]) {
    await assert.rejects(
      openConfiguredMaybeCode(
        { git: false, workspace },
        {
          async loadConfig() {
            throw new Error("config should not be loaded");
          },
        },
      ),
      /Git Bash removes unquoted backslashes.*E:\/code\/project/u,
    );
  }
});
