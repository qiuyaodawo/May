import assert from "node:assert/strict";
import { lstat, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { createTestDirectory, fc, pbtRuns } from "@sortedyuan/test-support";
import {
  openCodingExecutionEnvironment,
  resolveExistingWorkspacePath,
  resolveWritableWorkspacePath,
} from "../dist/index.js";

function isContained(root, target) {
  const rel = relative(root, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Independently verify on disk that every existing prefix of `target` stays inside `canonicalRoot`. */
function isMissingOrNonDir(error) {
  return Boolean(error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}

async function assertFilesystemContainment(canonicalRoot, target) {
  assert.ok(isContained(canonicalRoot, target), `lexical path escaped workspace: ${target}`);
  let probe = target;
  for (;;) {
    try {
      const real = await realpath(probe);
      assert.ok(isContained(canonicalRoot, real), `realpath(${probe})=${real} escaped ${canonicalRoot}`);
      break;
    } catch (error) {
      if (isMissingOrNonDir(error)) {
        // Also check dangling symlink at this prefix!
        try {
          const info = await lstat(probe);
          if (info.isSymbolicLink()) {
            assert.fail(`Resolved path traverses dangling symlink: ${probe}`);
          }
        } catch (lstatError) {
          if (!isMissingOrNonDir(lstatError)) throw lstatError;
        }
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
        continue;
      }
      throw error;
    }
  }
}

test("resolveWritableWorkspacePath handles regular file as intermediate segment cleanly across Windows and POSIX", async (t) => {
  const root = await createTestDirectory(t, "coding-tools/file-as-parent");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "sub"), { recursive: true });
  await writeFile(join(workspace, "sub", "ok.txt"), "ok", "utf8");
  const canonicalRoot = await realpath(workspace);

  const resolved = await resolveWritableWorkspacePath(workspace, "sub/ok.txt/child");
  assert.equal(resolved.absolute, join(canonicalRoot, "sub", "ok.txt", "child"));
  await assertFilesystemContainment(canonicalRoot, resolved.absolute);
});

test("resolveWritableWorkspacePath rejects a dangling intermediate symbolic link pointing outside the workspace", async (t) => {
  const root = await createTestDirectory(t, "coding-tools/dangling-symlink");
  const workspace = join(root, "workspace");
  const outsideMissing = join(root, "outside-missing");
  await mkdir(workspace, { recursive: true });
  await symlink(outsideMissing, join(workspace, "escape-link"), process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(resolveWritableWorkspacePath(workspace, "escape-link/pwn.txt"), {
    code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
  });
  await assert.rejects(resolveWritableWorkspacePath(workspace, "escape-link/nested/deep/pwn.txt"), {
    code: "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
  });
});

test("invariant: arbitrary adversarial relative/absolute paths never escape filesystem realpath(workspace)", async (t) => {
  const root = await createTestDirectory(t, "coding-tools/path-pbt");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(join(workspace, "sub"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(workspace, "sub", "ok.txt"), "ok", "utf8");
  await writeFile(join(outside, "secret.txt"), "secret", "utf8");
  await symlink(outside, join(workspace, "link-out"), process.platform === "win32" ? "junction" : "dir");

  const canonicalRoot = await realpath(workspace);
  const segmentArb = fc.oneof(
    fc.constant("."),
    fc.constant(".."),
    fc.constant("sub"),
    fc.constant("link-out"),
    fc.constant("ok.txt"),
    fc.constant("secret.txt"),
    fc.constant("new-dir"),
    fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/),
  );
  const relativePathArb = fc
    .tuple(fc.array(segmentArb, { minLength: 1, maxLength: 5 }), fc.constantFrom("/", "\\"))
    .map(([parts, divider]) => parts.join(divider));
  const absolutePathArb = fc
    .tuple(
      fc.constantFrom(workspace, outside, join(workspace, "link-out")),
      fc.array(segmentArb, { minLength: 1, maxLength: 3 }),
    )
    .map(([base, parts]) => join(base, ...parts));
  const pathArb = fc.oneof(relativePathArb, absolutePathArb);

  await fc.assert(
    fc.asyncProperty(pathArb, async (candidate) => {
      for (const resolveFn of [resolveWritableWorkspacePath, resolveExistingWorkspacePath]) {
        try {
          const resolved = await resolveFn(workspace, candidate);
          await assertFilesystemContainment(canonicalRoot, resolved.absolute);
        } catch (error) {
          assert.ok(
            error instanceof Error &&
              [
                "CODING_TOOL_PATH_OUTSIDE_WORKSPACE",
                "CODING_TOOL_PATH_NOT_FOUND",
                "CODING_TOOL_UNSAFE_HARD_LINK",
              ].includes(error.code),
            `Unexpected error for ${JSON.stringify(candidate)}: ${String(error)}`,
          );
        }
      }
    }),
    { numRuns: pbtRuns(100) },
  );

  // Positive-case invariant: valid in-workspace relative & absolute paths MUST resolve cleanly.
  const safeName = fc.stringMatching(/^[a-zA-Z0-9_-]{1,10}$/);
  await fc.assert(
    fc.asyncProperty(safeName, fc.boolean(), async (leaf, useAbsolute) => {
      const existingCandidate = useAbsolute ? join(workspace, "sub", "ok.txt") : "sub/ok.txt";
      const existing = await resolveExistingWorkspacePath(workspace, existingCandidate);
      assert.equal(existing.absolute, join(canonicalRoot, "sub", "ok.txt"));

      const writableCandidate = useAbsolute ? join(workspace, "sub", `${leaf}.txt`) : `sub/${leaf}.txt`;
      const writable = await resolveWritableWorkspacePath(workspace, writableCandidate);
      assert.equal(writable.absolute, join(canonicalRoot, "sub", `${leaf}.txt`));
      await assertFilesystemContainment(canonicalRoot, writable.absolute);
    }),
    { numRuns: pbtRuns(40) },
  );
});

test("invariant: host toEnvironmentPath/toHostPath round-trips for valid workspace paths and rejects escapes", async (t) => {
  const workspace = await createTestDirectory(t, "coding-tools/env-path-pbt");
  const env = await openCodingExecutionEnvironment({ workspace, isolation: { mode: "host" } });
  t.after(() => env.close());

  const safePart = fc.stringMatching(/^[a-zA-Z0-9._-]{1,12}$/).filter((part) => part !== "." && part !== "..");
  await fc.assert(
    fc.property(fc.array(safePart, { minLength: 1, maxLength: 4 }), (parts) => {
      const hostPath = join(env.workspace, ...parts);
      const envPath = env.toEnvironmentPath(hostPath);
      assert.equal(env.toHostPath(envPath), hostPath);
      assert.equal(env.toHostPath(join(env.workspace, "..", ...parts)), undefined);
    }),
    { numRuns: pbtRuns(100) },
  );
});
