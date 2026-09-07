import assert from "node:assert/strict";
import {
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodingInstructionsError,
  loadCodingInstructions,
} from "../dist/instructions.js";

test("loads configurable system, runtime, and project instruction sections", async (t) => {
  const workspace = await temporaryDirectory(t);
  const directory = join(workspace, ".prompts");
  await mkdir(directory);
  await writeFile(join(directory, "agent-system.txt"), "file system", "utf8");
  await writeFile(join(workspace, "PROJECT.md"), "workspace rules", "utf8");

  const instructions = await loadCodingInstructions({
    workspace,
    defaultSystemInstructions: "fallback system",
    instructionsDirectory: directory,
    runtimeInstructions: "node runtime",
    systemInstructionsFilename: "agent-system.txt",
    projectInstructionsFilename: "PROJECT.md",
    sectionLabels: { runtime: "Environment", project: "Repository rules" },
    maxBytes: 128,
  });

  assert.deepEqual(instructions.system.source, {
    type: "file",
    path: join(directory, "agent-system.txt"),
  });
  assert.deepEqual(instructions.runtime?.source, { type: "runtime" });
  assert.deepEqual(instructions.project?.source, {
    type: "file",
    path: join(workspace, "PROJECT.md"),
  });
  assert.equal(
    instructions.effective,
    "file system\n\n# Environment\n\nnode runtime\n\n" +
      "# Repository rules\n\nworkspace rules",
  );
});

test("prefers explicit instructions and can disable project discovery", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "AGENTS.md"), "not loaded", "utf8");

  const instructions = await loadCodingInstructions({
    workspace,
    defaultSystemInstructions: "fallback system",
    systemInstructions: "explicit system",
    instructionsDirectory: join(workspace, "missing"),
    projectInstructionsFilename: false,
  });

  assert.deepEqual(instructions.system.source, { type: "explicit" });
  assert.equal(instructions.project, undefined);
  assert.equal(instructions.effective, "explicit system");
});

test("enforces bounded, non-empty strict UTF-8 instruction documents", async (t) => {
  const workspace = await temporaryDirectory(t);
  const directory = join(workspace, "instructions");
  await mkdir(directory);

  await writeFile(join(directory, "system.md"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    loadCodingInstructions({
      workspace,
      defaultSystemInstructions: "fallback",
      instructionsDirectory: directory,
    }),
    hasCode("CODING_INSTRUCTIONS_INVALID_UTF8"),
  );

  await writeFile(join(directory, "system.md"), "12345", "utf8");
  await assert.rejects(
    loadCodingInstructions({
      workspace,
      defaultSystemInstructions: "fallback",
      instructionsDirectory: directory,
      maxBytes: 4,
    }),
    hasCode("CODING_INSTRUCTIONS_TOO_LARGE"),
  );

  await assert.rejects(
    loadCodingInstructions({
      workspace,
      defaultSystemInstructions: " ",
      projectInstructionsFilename: false,
    }),
    hasCode("CODING_INSTRUCTIONS_EMPTY"),
  );
});

test("rejects unsafe project instruction filenames and links", async (t) => {
  const workspace = await temporaryDirectory(t);
  const outside = join(await temporaryDirectory(t), "outside.md");
  await writeFile(outside, "external secret", "utf8");

  await assert.rejects(
    loadCodingInstructions({
      workspace,
      defaultSystemInstructions: "system",
      projectInstructionsFilename: "../outside.md",
    }),
    hasCode("CODING_INSTRUCTIONS_INVALID_OPTION"),
  );

  await link(outside, join(workspace, "AGENTS.md"));
  await assert.rejects(
    loadCodingInstructions({
      workspace,
      defaultSystemInstructions: "system",
    }),
    hasCode("CODING_INSTRUCTIONS_UNSAFE_LINK"),
  );
  await rm(join(workspace, "AGENTS.md"));

  try {
    await symlink(outside, join(workspace, "AGENTS.md"), "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return;
    }
    throw error;
  }
  await assert.rejects(
    loadCodingInstructions({
      workspace,
      defaultSystemInstructions: "system",
    }),
    hasCode("CODING_INSTRUCTIONS_UNSAFE_LINK"),
  );
});

function hasCode(code) {
  return (error) =>
    error instanceof CodingInstructionsError && error.code === code;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "may-instructions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
