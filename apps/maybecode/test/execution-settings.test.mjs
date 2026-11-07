import assert from "node:assert/strict";
import test from "node:test";
import { readMaybeCodeSettings } from "../dist/settings.js";

function settings(value) {
  return readMaybeCodeSettings({ path: "may.config.json", apps: { maybecode: value } });
}

test("execution and fetch configuration accepts complete isolation and explicit local origins", () => {
  const value = {
    execution: {
      mode: "container",
      image: "nixery.dev/shell/git/ripgrep/util-linux",
      network: "none",
      memoryBytes: 268435456,
      cpuCount: 0.5,
    },
    fetch: { allowedOrigins: ["http://127.0.0.1:8080"], maxBytes: 4096, timeoutMs: 1000, maxRedirects: 0 },
  };
  assert.deepEqual(settings(value), value);
  assert.deepEqual(settings({ execution: { mode: "host" } }).execution, { mode: "host" });
});

test("invalid isolation and fetch values report configuration field paths", () => {
  for (const [value, field] of [
    [
      { execution: { mode: "container", image: "image", network: "none", memoryBytes: 0, cpuCount: 1 } },
      "execution.memoryBytes",
    ],
    [
      { execution: { mode: "container", image: "image", network: "none", memoryBytes: 4096, cpuCount: -1 } },
      "execution.cpuCount",
    ],
    [{ fetch: { maxBytes: 0 } }, "fetch.maxBytes"],
    [{ fetch: { maxRedirects: -1 } }, "fetch.maxRedirects"],
    [{ fetch: { allowedOrigins: ["http://localhost:99999"] } }, "fetch.allowedOrigins.0"],
  ]) {
    assert.throws(
      () => settings(value),
      (error) => error.name === "MayConfigValidationError" && error.field === `apps.maybecode.${field}`,
    );
  }
});
