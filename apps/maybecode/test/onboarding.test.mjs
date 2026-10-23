import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function onboardingDirectory(t) {
  const base = fileURLToPath(new URL("../../../review/onboarding/", import.meta.url));
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "cli-"));
  const home = join(root, "home");
  await mkdir(home);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, home };
}

test("missing config without a terminal exits with instructions and creates no files", async t => {
  const { root, home } = await onboardingDirectory(t);
  await assert.rejects(promisify(execFile)(process.execPath, [bin], {
    cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home }, windowsHide: true,
  }), error => error.code === 1 && error.stdout.includes("interactive terminal") && error.stdout.includes(join(home, ".may", "config.json")));
  assert.deepEqual(await readdir(home), []);
});

test("existing malformed config reports its error without entering onboarding", async t => {
  const dirs = await onboardingDirectory(t);
  const path = join(dirs.root, "config.json");
  await writeFile(path, "{");
  await assert.rejects(promisify(execFile)(process.execPath, [bin, "--config", path], { cwd: dirs.root, windowsHide: true }),
    error => error.code === 1 && error.stdout.includes("not valid JSON") && !error.stdout.includes("Welcome to MaybeCode"));
  assert.equal(await readFile(path, "utf8"), "{");
});

test("web mode validates its token before prompting", async t => {
  const dirs = await onboardingDirectory(t);
  await assert.rejects(promisify(execFile)(process.execPath, [bin, "--ui", "web"], {
    cwd: dirs.root, env: { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home, MAYBECODE_CONTROL_TOKEN: "" }, windowsHide: true,
  }), error => error.code === 1 && error.stdout.includes("MAYBECODE_CONTROL_TOKEN") && !error.stdout.includes("Welcome to MaybeCode"));
  assert.deepEqual(await readdir(dirs.home), []);
});
