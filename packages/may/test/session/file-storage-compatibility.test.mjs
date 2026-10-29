import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as storage from "@sortedyuan/may/storage";
import { withFileAccess } from "@sortedyuan/may/session/file-access";
import { acquireFileLock, recoverFileLock, releaseFileLock, replaceJournalFile, syncDirectory } from "@sortedyuan/may/session/file-store";

test("Session file exports share implementation and reentrant-access detection with file-storage", async t => {
  assert.equal(withFileAccess, storage.withFileAccess);
  for (const [name, value] of Object.entries({ acquireFileLock, recoverFileLock, releaseFileLock, replaceJournalFile, syncDirectory })) {
    assert.equal(value, storage[name]);
  }
  const root = fileURLToPath(new URL("../../../../review/file-storage-compatibility/", import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "access-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "record.json");
  await withFileAccess(path, "exclusive", async () => {
    await assert.rejects(storage.withFileAccess(path, "shared", async () => {}), { code: "FILE_ACCESS_REENTRANT" });
  });
  await storage.withFileAccess(path, "shared", async () => {
    await assert.rejects(withFileAccess(path, "exclusive", async () => {}), { code: "FILE_ACCESS_REENTRANT" });
  });
});
