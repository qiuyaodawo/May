import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileSessionCatalog } from "../dist/index.js";

test("persists and updates session summaries", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "catalog.json");
  const first = new FileSessionCatalog(path);
  await first.record({
    id: "one",
    workspace: directory,
    createdAt: 1,
    lastUsedAt: 2,
  });
  await first.record({
    id: "two",
    workspace: directory,
    createdAt: 3,
    lastUsedAt: 4,
  });
  await first.record({
    id: "one",
    workspace: directory,
    createdAt: 99,
    lastUsedAt: 5,
  });

  const sessions = await new FileSessionCatalog(path).list(directory);
  assert.deepEqual(sessions.map((session) => session.id), ["one", "two"]);
  assert.equal(sessions[0].createdAt, 1);
  assert.equal(sessions[0].lastUsedAt, 5);
});

test("rejects a corrupt session catalog", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "catalog.json");
  await writeFile(path, "not-json", "utf8");

  await assert.rejects(
    new FileSessionCatalog(path).list(directory),
    /Invalid MaybeCode session catalog JSON/,
  );
});

test("does not lose concurrent updates from separate catalog instances", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "catalog.json");
  const first = new FileSessionCatalog(path);
  const second = new FileSessionCatalog(path);
  const originalNow = Date.now;
  Date.now = () => 1_900_000_000_000;
  try {
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      (index % 2 === 0 ? first : second).record({
        id: `session-${index}`,
        workspace: directory,
        createdAt: index,
        lastUsedAt: index,
      })
    ));
    await first.record({
      id: "rename-me",
      workspace: directory,
      createdAt: 100,
      lastUsedAt: 100,
    });
    assert.equal(await second.rename("rename-me", directory, "renamed"), true);
  } finally {
    Date.now = originalNow;
  }

  const sessions = await new FileSessionCatalog(path).list(directory);
  assert.equal(sessions.length, 41);
  assert.equal(sessions.find((item) => item.id === "rename-me")?.title, "renamed");
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
