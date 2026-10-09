import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_MAYBE_CODE_INSTRUCTIONS, loadMaybeCodeInstructions, MaybeCodeConfigError, MaybeCodeInstructionState, resolveMaybeCodeInstructionsDirectory } from "../dist/index.js";

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
    `custom system\n\n# Project instructions\n\nSource: ${await realpath(join(workspace, "AGENTS.md"))}\n\nproject rules`,
  );
  assert.doesNotMatch(instructions.effective, /You are MaybeCode/u);
});

test("combines startup ancestor rules while keeping the configured workspace", async (t) => {
  const repository = await temporaryDirectory(t);
  const workspace = join(repository, "packages", "web");
  await mkdir(join(repository, ".git"));
  await mkdir(join(workspace, "src"), { recursive: true });
  await writeFile(join(repository, "AGENTS.md"), "Repository guidance.");
  await writeFile(join(repository, "packages", "AGENTS.md"), "Package guidance.");
  await writeFile(join(workspace, "AGENTS.override.md"), "Web guidance.");
  await writeFile(join(workspace, "AGENTS.md"), "Inactive web guidance.");
  await writeFile(join(workspace, "src", "AGENTS.md"), "Deeper guidance.");

  const instructions = await loadMaybeCodeInstructions({ workspace });
  assert.deepEqual(instructions.projects.map(document => document.content), [
    "Repository guidance.", "Package guidance.", "Web guidance.",
  ]);
  assert.equal(instructions.project, instructions.projects.at(-1));
  for (const document of instructions.projects) {
    assert.ok(instructions.effective.includes(`Source: ${document.source.path}`));
  }
  assert.ok(instructions.effective.indexOf("Repository guidance.") < instructions.effective.indexOf("Package guidance."));
  assert.ok(instructions.effective.indexOf("Package guidance.") < instructions.effective.indexOf("Web guidance."));
  assert.doesNotMatch(instructions.effective, /Inactive web guidance|Deeper guidance/u);
  const state = new MaybeCodeInstructionState(workspace, instructions);
  assert.equal(state.workspace, workspace);
  assert.equal(state.projectInstructions(), instructions.effective.slice(instructions.effective.indexOf("# Project instructions")));
});

test("refreshes the entire ancestor chain and override selection", async (t) => {
  const repository = await temporaryDirectory(t);
  const workspace = join(repository, "web");
  await mkdir(join(repository, ".git"));
  await mkdir(workspace);
  await writeFile(join(repository, "AGENTS.md"), "Root original.");
  await writeFile(join(workspace, "AGENTS.md"), "Web original.");
  const state = new MaybeCodeInstructionState(workspace, await loadMaybeCodeInstructions({ workspace }));
  const system = state.current.system;

  await writeFile(join(repository, "AGENTS.md"), "Root updated.");
  await writeFile(join(repository, "AGENTS.override.md"), "Root override.");
  await state.refreshProject();
  assert.deepEqual(state.current.projects.map(document => document.content), ["Root override.", "Web original."]);
  assert.equal(state.current.system, system);
  assert.doesNotMatch(state.projectInstructions(), /Root original|Root updated/u);

  await rm(join(repository, "AGENTS.override.md"));
  await rm(join(workspace, "AGENTS.md"));
  await state.refreshProject();
  assert.deepEqual(state.current.projects.map(document => document.content), ["Root updated."]);
  assert.equal(state.current.project.source.path, await realpath(join(repository, "AGENTS.md")));
  state.runtimeInstructions = () => `Workspace: ${workspace}`;
  assert.ok(state.current.effective.includes(`Workspace: ${workspace}`));
  assert.match(state.current.effective, /Root updated/u);
  assert.doesNotMatch(state.current.effective, /Root override|Web original/u);

  await rm(join(repository, "AGENTS.md"));
  await state.refreshProject();
  assert.deepEqual(state.current.projects, []);
  assert.equal(state.projectInstructions(), "");
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
