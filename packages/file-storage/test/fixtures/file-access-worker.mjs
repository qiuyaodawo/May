import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import { withFileAccess } from "../../dist/file-access.js";

const [operation, path, mode = "shared"] = process.argv.slice(2);
assert.ok(process.send);

if (operation === "hold") {
  const released = new Promise(resolve => process.once("message", resolve));
  await withFileAccess(path, mode, async () => {
    process.send({ type: "acquired" });
    await released;
  });
  process.send({ type: "released" });
} else if (operation === "read-loop") {
  let stopped = false;
  let reads = 0;
  let previousRevision = -1;
  process.on("message", () => { stopped = true; });
  while (!stopped) {
    await withFileAccess(path, "shared", async () => {
      const file = await open(path, "r");
      try {
        const value = JSON.parse(await file.readFile("utf8"));
        assert.ok(value.revision >= previousRevision);
        assert.equal(value.payload, String(value.revision).repeat(4096));
        previousRevision = value.revision;
        reads += 1;
      } finally { await file.close(); }
    });
    if (reads === 1) process.send({ type: "acquired" });
  }
  process.send({ type: "stopped", reads });
} else {
  throw new Error(`Unknown file access operation: ${operation}`);
}

process.disconnect();
