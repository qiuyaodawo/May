import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getDefaultMayConfigPath,
  loadMayConfig,
  MayConfigFileError,
  MayConfigParseError,
  MayConfigResolutionError,
  MayConfigValidationError,
  parseMayConfig,
  resolveModelProfile,
  resolveProviderConfig,
} from "../dist/index.js";

test("parses the existing provider-only config shape", () => {
  const config = parseMayConfig({
    providers: {
      deepseek: {
        apiKey: "test-key",
        baseURL: "https://example.test",
        model: "deepseek-reasoner",
        maxTokens: 4096,
      },
    },
  }, "memory.json");

  assert.equal(config.path, "memory.json");
  assert.deepEqual(config.models, {});
  assert.deepEqual(config.apps, {});
  assert.deepEqual(config.providers.deepseek, {
    apiKey: "test-key",
    baseURL: "https://example.test",
    model: "deepseek-reasoner",
    maxTokens: 4096,
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
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseURL: "https://example.test",
      },
    },
    models: {
      reasoner: {
        provider: "deepseek",
        model: "deepseek-reasoner",
        options: { maxTokens: 8192 },
      },
    },
  });

  const resolved = resolveModelProfile(config, undefined, {
    env: { DEEPSEEK_API_KEY: "env-key" },
  });

  assert.deepEqual(resolved, {
    name: "reasoner",
    provider: "deepseek",
    model: "deepseek-reasoner",
    options: { maxTokens: 8192 },
    providerConfig: {
      apiKeyEnv: "DEEPSEEK_API_KEY",
      apiKey: "env-key",
      baseURL: "https://example.test",
    },
  });
});

test("resolves apiKeyEnv lazily", () => {
  const config = parseMayConfig({
    providers: {
      deepseek: { apiKeyEnv: "MISSING_DEEPSEEK_KEY" },
      local: { apiKey: "direct-key" },
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
    ["missing providers", {}, "providers"],
    ["non-object provider", { providers: { deepseek: [] } }, "providers.deepseek"],
    ["non-object application", { providers: {}, apps: { maybecode: [] } }, "apps.maybecode"],
    ["empty known field", { providers: { deepseek: { apiKey: " " } } }, "providers.deepseek.apiKey"],
    [
      "two API key sources",
      { providers: { deepseek: { apiKey: "key", apiKeyEnv: "KEY" } } },
      "providers.deepseek",
    ],
    [
      "non-object model options",
      {
        providers: { deepseek: {} },
        models: { reasoner: { provider: "deepseek", model: "model", options: [] } },
      },
      "models.reasoner.options",
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
    providers: { deepseek: { apiKey: "test-key" } },
  }));

  const config = await loadMayConfig({ path });

  assert.equal(config.path, path);
  assert.equal(config.providers.deepseek.apiKey, "test-key");
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

test("returns the default user config path", () => {
  const path = getDefaultMayConfigPath();

  assert.ok(path.endsWith(join(".may", "config.json")));
});
