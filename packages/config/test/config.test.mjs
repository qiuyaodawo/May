import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMayConfig, MayConfigFileError, MayConfigParseError, MayConfigResolutionError, MayConfigValidationError, parseMayConfig, resolveModelProfile, resolveProviderConfig, updateDefaultMayModel } from "../dist/index.js";

test("parses provider connections and model profiles", () => {
  const config = parseMayConfig({
    providers: {
      gateway: {
        adapter: "openai-responses",
        apiKey: "test-key",
        baseURL: "https://example.test",
        options: { store: false },
      },
    },
    models: {
      chat: {
        provider: "gateway",
        adapter: "openai-chat-completions",
        model: "test-model",
        capabilities: {
          reasoning: {
            efforts: ["low", "high"],
            defaultEffort: "high",
          },
        },
      },
    },
  }, "memory.json");

  assert.equal(config.path, "memory.json");
  assert.deepEqual(config.models.chat, {
    provider: "gateway",
    adapter: "openai-chat-completions",
    model: "test-model",
    capabilities: {
      reasoning: {
        efforts: ["low", "high"],
        defaultEffort: "high",
      },
    },
  });
  assert.deepEqual(config.apps, {});
  assert.deepEqual(config.providers.gateway, {
    adapter: "openai-responses",
    apiKey: "test-key",
    baseURL: "https://example.test",
    options: { store: false },
  });
  const resolved = resolveModelProfile(config, "chat");
  assert.equal(resolved.adapter, "openai-chat-completions");
  assert.deepEqual(resolved.options, { store: false });
  assert.deepEqual(resolved.capabilities, {
    reasoning: { efforts: ["low", "high"], defaultEffort: "high" },
  });
});

test("parses generic application configuration", () => {
  const config = parseMayConfig({
    providers: {},
    apps: {
      maybecode: {
        instructionsDirectory: "~/.may/instructions/maybecode",
      },
    },
  });

  assert.deepEqual(config.apps, {
    maybecode: {
      instructionsDirectory: "~/.may/instructions/maybecode",
    },
  });
});

test("resolves the default model profile and provider environment key", () => {
  const config = parseMayConfig({
    defaultModel: "reasoner",
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseURL: "https://example.test",
        options: { thinking: "enabled", maxTokens: 16000 },
      },
    },
    models: {
      reasoner: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        contextWindowTokens: 64000,
        maxOutputTokens: 8192,
        options: { maxTokens: 8192, reasoningEffort: "high" },
      },
    },
  });

  const resolved = resolveModelProfile(config, undefined, {
    env: { DEEPSEEK_API_KEY: "env-key" },
  });

  assert.deepEqual(resolved, {
    name: "reasoner",
    provider: "deepseek",
    adapter: "deepseek-chat",
    model: "deepseek-reasoner",
    contextWindowTokens: 64000,
    maxOutputTokens: 8192,
    options: {
      thinking: "enabled",
      maxTokens: 8192,
      reasoningEffort: "high",
    },
    providerConfig: {
      adapter: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiKey: "env-key",
      baseURL: "https://example.test",
      options: { thinking: "enabled", maxTokens: 16000 },
    },
  });
});

test("resolves apiKeyEnv lazily", () => {
  const config = parseMayConfig({
    providers: {
      deepseek: {
        adapter: "deepseek-chat",
        apiKeyEnv: "MISSING_DEEPSEEK_KEY",
      },
      local: { adapter: "openai-chat-completions", apiKey: "direct-key" },
    },
  });

  assert.equal(resolveProviderConfig(config, "local").apiKey, "direct-key");
  assert.throws(
    () => resolveProviderConfig(config, "deepseek", { env: {} }),
    (error) => {
      assert.ok(error instanceof MayConfigResolutionError);
      assert.equal(error.code, "MAY_CONFIG_RESOLUTION_ERROR");
      assert.match(error.message, /MISSING_DEEPSEEK_KEY/);
      return true;
    },
  );
});

test("rejects invalid config shapes", async (t) => {
  const cases = [
    ["non-object root", null, "config"],
    [
      "unknown root field",
      { providers: {}, defaultModal: "typo" },
      "config.defaultModal",
    ],
    [
      "two API key sources",
      { providers: { deepseek: { adapter: "deepseek-chat", apiKey: "key", apiKeyEnv: "KEY" } } },
      "providers.deepseek",
    ],
    [
      "unknown model provider",
      {
        providers: {},
        models: { reasoner: { provider: "toString", model: "model" } },
      },
      "models.reasoner.provider",
    ],
    [
      "unknown default model",
      { providers: {}, models: {}, defaultModel: "toString" },
      "defaultModel",
    ],
  ];

  for (const [name, value, field] of cases) {
    await t.test(name, () => {
      assert.throws(
        () => parseMayConfig(value, "invalid.json"),
        (error) => {
          assert.ok(error instanceof MayConfigValidationError);
          assert.equal(error.code, "MAY_CONFIG_VALIDATION_ERROR");
          assert.equal(error.path, "invalid.json");
          assert.equal(error.field, field);
          return true;
        },
      );
    });
  }
});

test("rejects unknown provider and model selections", () => {
  const config = parseMayConfig({ providers: {} });

  assert.throws(
    () => resolveProviderConfig(config, "toString"),
    /Unknown provider "toString"/,
  );
  assert.throws(
    () => resolveModelProfile(config),
    /defaultModel is not configured/,
  );
  assert.throws(
    () => resolveModelProfile(config, "toString"),
    /Unknown model "toString"/,
  );
});

test("loads a config from a custom path", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "may-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({
    providers: {
      deepseek: { adapter: "deepseek-chat", apiKey: "test-key" },
    },
  }));

  const config = await loadMayConfig({ path });

  assert.equal(config.path, path);
  assert.equal(config.providers.deepseek.apiKey, "test-key");
});

test("atomically updates only the default model with existing formatting", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "may-config-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  const source = JSON.stringify({
    providers: {
      local: { adapter: "openai-responses", apiKey: "test" },
    },
    models: {
      first: { provider: "local", model: "first-model" },
      second: { provider: "local", model: "second-model" },
    },
    defaultModel: "first",
  }, null, 4).replace(/\n/gu, "\r\n") + "\r\n";
  await writeFile(path, source);

  const updated = await updateDefaultMayModel(path, "second");
  const written = await readFile(path, "utf8");

  assert.equal(updated.defaultModel, "second");
  assert.equal(JSON.parse(written).defaultModel, "second");
  assert.match(written, /\r\n    "providers"/u);
  assert.equal(written.endsWith("\r\n"), true);
});

test("distinguishes file and JSON parsing failures", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "may-config-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const missingPath = join(directory, "missing.json");
  const invalidPath = join(directory, "invalid.json");
  await writeFile(invalidPath, "{");

  await assert.rejects(
    loadMayConfig({ path: missingPath }),
    (error) => {
      assert.ok(error instanceof MayConfigFileError);
      assert.equal(error.code, "MAY_CONFIG_FILE_ERROR");
      assert.equal(error.path, missingPath);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
  await assert.rejects(
    loadMayConfig({ path: invalidPath }),
    (error) => {
      assert.ok(error instanceof MayConfigParseError);
      assert.equal(error.code, "MAY_CONFIG_PARSE_ERROR");
      assert.equal(error.path, invalidPath);
      assert.ok(error.cause instanceof Error);
      return true;
    },
  );
});
