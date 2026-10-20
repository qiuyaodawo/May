import assert from "node:assert/strict";
import { once } from "node:events";
import { targetFor } from "./file-lock-targets.mjs";

const [name, directory] = process.argv.slice(2);
assert.ok(process.send);
const target = await targetFor(name, directory);
const release = once(process, "message");
process.send({ type: "starting" });
try {
  const owner = await target.acquire();
  process.send({ type: "acquired" });
  if (!target.oneShot) await release;
  await owner.close();
} catch (error) {
  process.send({ type: "error", name: error.name, code: error.code, message: error.message });
  process.exitCode = 1;
}
process.disconnect();
