import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { runMaybeClaw } from "../dist/index.js";

test("CLI requires explicit sessions and rejects obsolete per-task startup options", async () => {
  let output = "";
  let error = "";
  const deps = {
    stdout: {
      write: (s) => {
        output += s;
      },
    },
    stderr: {
      write: (s) => {
        error += s;
      },
    },
  };
  assert.equal(await runMaybeClaw(["task", "submit", "Say hello", "--request-id", "cli"], deps), 2);
  assert.match(error, /--session/);
  assert.equal(output, "");
  assert.equal(await runMaybeClaw(["task", "submit", "hello", "--session", "chosen", "--model", "other"], deps), 2);
  assert.equal(await runMaybeClaw(["task", "submit", "hello", "--session", "chosen", "--enqueue"], deps), 2);
  assert.equal(await runMaybeClaw(["task", "submit", "a", "b"], deps), 2);
});

test("CLI manages configured Agent sessions without allocating a model conversation", async (t) => {
  const parent = fileURLToPath(new URL("../../../.test-output/maybeclaw/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(join(parent, "case-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      providers: {},
      models: {},
      apps: { maybeclaw: { version: 2, agents: [{ id: "code", adapter: "may" }] } },
    }),
  );
  let output = "",
    error = "";
  const deps = {
    stdout: {
      write(value) {
        output += value;
      },
    },
    stderr: {
      write(value) {
        error += value;
      },
    },
  };
  const common = ["--config", configPath, "--data-directory", join(root, "state")];
  assert.equal(await runMaybeClaw(["session", "create", "明确会话", "--agent", "code", ...common], deps), 0, error);
  const id = JSON.parse(output).selectedId;
  output = "";
  assert.equal(await runMaybeClaw(["session", "show", id, ...common], deps), 0, error);
  assert.deepEqual(JSON.parse(output).defaultAgents, ["code"]);
});
