import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_MAYBE_CODE_INSTRUCTIONS, loadMaybeCodeInstructions, MaybeCodeConfigError, resolveMaybeCodeInstructionsDirectory } from "../dist/index.js";

test("uses the built-in system prompt when no override is configured", async (t) => {
  const workspace = await temporaryDirectory(t);

  const instructions = await loadMaybeCodeInstructions({ workspace });

  assert.equal(instructions.system.source.type, "built-in");
  assert.equal(instructions.system.content, DEFAULT_MAYBE_CODE_INSTRUCTIONS);
  assert.equal(instructions.project, undefined);
  assert.equal(instructions.effective, DEFAULT_MAYBE_CODE_INSTRUCTIONS);
});

test("replaces the built-in prompt and appends workspace AGENTS.md", async (t) => {
  const workspace = await temporaryDirectory(t);
  const directory = join(workspace, ".instructions");
  await mkdir(directory);
  await writeFile(join(directory, "system.md"), "custom system", "utf8");
  await writeFile(join(workspace, "AGENTS.md"), "project rules", "utf8");

  const instructions = await loadMaybeCodeInstructions({
    workspace,
    instructionsDirectory: directory,
  });

  assert.deepEqual(instructions.system.source, {
    type: "file",
    path: await realpath(join(directory, "system.md")),
  });
  assert.equal(instructions.system.content, "custom system");
  assert.equal(instructions.project.content, "project rules");
  assert.equal(
    instructions.effective,
    "custom system\n\n# Project instructions\n\nproject rules",
  );
  assert.doesNotMatch(instructions.effective, /You are MaybeCode/u);
});

test("resolves the maybecode instruction directory from config", () => {
  const configPath = join(process.cwd(), "config", "config.json");
  const relative = resolveMaybeCodeInstructionsDirectory({
    path: configPath,
    providers: {},
    models: {},
    apps: {
      maybecode: { instructionsDirectory: "instructions/maybecode" },
    },
  });
  const home = resolveMaybeCodeInstructionsDirectory({
    path: "config.json",
    providers: {},
    models: {},
    apps: {
      maybecode: { instructionsDirectory: "~/.may/instructions/maybecode" },
    },
  });

  assert.equal(
    relative,
    join(process.cwd(), "config", "instructions", "maybecode"),
  );
  assert.equal(home, join(homedir(), ".may", "instructions", "maybecode"));
  assert.throws(
    () => resolveMaybeCodeInstructionsDirectory({
      path: configPath,
      providers: {},
      models: {},
      apps: { maybecode: { instructionsDirectory: 42 } },
    }),
    /apps\.maybecode\.instructionsDirectory must be a non-empty string/u,
  );
});

test("rejects invalid or missing system instructions", async (t) => {
  const workspace = await temporaryDirectory(t);
  const directory = join(workspace, "instructions");
  await mkdir(directory);

  await assert.rejects(
    loadMaybeCodeInstructions({ workspace, instructionsDirectory: directory }),
    (error) => {
      assert.ok(error instanceof MaybeCodeConfigError);
      assert.match(error.message, /Unable to read system instructions/u);
      return true;
    },
  );

  await writeFile(join(directory, "system.md"), "   ", "utf8");
  await assert.rejects(
    loadMaybeCodeInstructions({ workspace, instructionsDirectory: directory }),
    /must not be empty/u,
  );

  await writeFile(join(directory, "system.md"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    loadMaybeCodeInstructions({ workspace, instructionsDirectory: directory }),
    /must be valid UTF-8/u,
  );
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-instructions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
