import assert from "node:assert/strict";
import { FileTaskStore } from "../../dist/store.js";

const [directory, id, rawSize] = process.argv.slice(2);
const content = "x".repeat(Number(rawSize));
const store = new FileTaskStore(directory);
let stop = false;
let reads = 0;
process.once("message", message => { assert.equal(message, "stop"); stop = true; });
assert.equal((await store.inspect(id)).revision, 126);
process.send({ type: "ready" });
await Promise.all(Array.from({ length: 4 }, async () => {
  let revision = 126;
  while (!stop) {
    const value = await store.inspect(id);
    assert.ok(value.revision >= revision);
    assert.equal(value.spec.prompt, content);
    revision = value.revision;
    reads++;
  }
}));
process.send({ type: "finished", reads, revision: (await store.inspect(id)).revision });
process.disconnect();
