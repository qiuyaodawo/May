import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { withFileAccess } from "@sortedyuan/may/storage";
import { KeyringMcpCredentialStore } from "../../dist/credentials.js";

const [operation, directory, key] = process.argv.slice(2);
assert.ok(process.send);
const store = new KeyringMcpCredentialStore(directory);
const released = new Promise(resolve => process.once("message", resolve));
const path = join(directory, `${createHash("sha256").update(key).digest("hex")}.lock`);

if (operation === "pending-delete") {
  await withFileAccess(path, "exclusive", async () => {
    await writeFile(path, JSON.stringify({ pid: process.pid }), { flag: "wx" });
    const child = spawn("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File",
      fileURLToPath(new URL("./pending-delete.ps1", import.meta.url)), "-TargetPath", path,
    ], { windowsHide: true, stdio: ["pipe", "pipe", "inherit"] });
    const closed = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    try {
      const ready = once(lines, "line").then(([line]) => line);
      assert.equal(await Promise.race([ready, closed.then(result => { throw new Error(`Delete helper exited: ${result}`); })]), "delete-pending");
      process.send({ type: "acquired" });
      await released;
    } finally {
      child.stdin.end("\n");
      assert.deepEqual(await closed, [0, null]);
      lines.close();
    }
  });
} else if (operation === "hold") {
  await store.exclusive(key, async () => {
    process.send({ type: "acquired" });
    await released;
  });
} else if (operation === "increment") {
  process.send({ type: "ready" });
  await released;
  for (let index = 0; index < 40; index += 1) {
    await store.exclusive(key, async () => {
      const sentinelPath = join(directory, "active");
      const sentinel = await open(sentinelPath, "wx");
      try {
        const counterPath = join(directory, "counter.json");
        const counter = JSON.parse(await readFile(counterPath, "utf8"));
        await writeFile(counterPath, JSON.stringify(counter + 1));
      } finally {
        await sentinel.close();
        await unlink(sentinelPath);
      }
    });
  }
} else {
  throw new Error(`Unknown operation: ${operation}`);
}
process.disconnect();
