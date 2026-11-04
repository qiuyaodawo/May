import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Ignored root for all repository test data. */
export const testOutputRoot = fileURLToPath(new URL("../../.test-output/", import.meta.url));

/** Model profile for tests that call a real provider: `MAY_LIVE_MODEL`, otherwise the configured `defaultModel`. */
export function selectLiveModelProfile(config) {
  const profile = process.env.MAY_LIVE_MODEL || config.defaultModel;
  if (profile === undefined) throw new Error(`Set MAY_LIVE_MODEL or defaultModel in ${config.path}`);
  if (!Object.hasOwn(config.models, profile)) throw new Error(`Model profile "${profile}" is not configured in ${config.path}`);
  return profile;
}

/** Second real model profile for model switching tests, read from `MAY_LIVE_SWITCH_MODEL`. */
export function selectLiveSwitchModelProfile(config) {
  const profile = process.env.MAY_LIVE_SWITCH_MODEL;
  if (!profile) throw new Error("Set MAY_LIVE_SWITCH_MODEL to a second configured model profile");
  if (!Object.hasOwn(config.models, profile)) throw new Error(`Model profile "${profile}" is not configured in ${config.path}`);
  if (profile === selectLiveModelProfile(config)) throw new Error("MAY_LIVE_SWITCH_MODEL must differ from the live model profile");
  return profile;
}

/**
 * Create `<repository>/.test-output/<name>-XXXXXX` for one test and remove it after the test.
 * `name` usually starts with the package, for example `coordination/pricing`.
 */
export async function createTestDirectory(t, name) {
  const prefix = join(testOutputRoot, name);
  await mkdir(join(prefix, ".."), { recursive: true });
  const directory = await mkdtemp(`${prefix}-`);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
