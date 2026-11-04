import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadMayConfig, parseMayConfig, resolveProviderConfig } from "@sortedyuan/may/config";
import { checkOnboardingConnection } from "../../dist/onboarding.js";
import { liveModelProfile } from "../fixtures/live-model.mjs";

const name = liveModelProfile();
const options = { timeout: 40_000 };

async function configuration() {
  const config = await loadMayConfig();
  return { ...config, defaultModel: name };
}

test("onboarding receives a completed response from the configured real provider", options, async () => {
  await checkOnboardingConnection(await configuration(), new AbortController().signal);
});

test("the real provider rejects an invalid onboarding credential", options, async () => {
  const config = await configuration();
  const profile = config.models[name];
  const resolved = resolveProviderConfig(config, profile.provider);
  const { apiKeyEnv, ...provider } = resolved;
  const { path, ...file } = config;
  const invalid = parseMayConfig(
    { ...file, providers: { ...config.providers, [profile.provider]: { ...provider, apiKey: randomUUID() } } },
    path,
  );
  await assert.rejects(checkOnboardingConnection(invalid, new AbortController().signal), (error) =>
    [401, 403].includes(error.status),
  );
});

test("a real onboarding request obeys its timeout and cancellation signal", options, async () => {
  const config = await configuration();
  const start = performance.now();
  await assert.rejects(checkOnboardingConnection(config, new AbortController().signal, 1));
  assert.ok(performance.now() - start < 5000);
  const reason = new Error("User cancelled setup");
  await assert.rejects(checkOnboardingConnection(config, AbortSignal.abort(reason)), (error) => error === reason);
});
