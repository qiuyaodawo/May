import assert from "node:assert/strict";
import { join } from "node:path";
import { FileCoordinationStore } from "../../dist/file-store.js";
import { ResourceJournal } from "../../dist/resource-journal.js";

const [kind, directory, rawMaxBytes] = process.argv.slice(2);
const maxBytes = Number(rawMaxBytes);
const content = "x".repeat(48 * 1024);
const store = new FileCoordinationStore(directory, maxBytes);
const inspect = kind === "coordination"
  ? () => store.inspect("reading")
  : () => ResourceJournal.inspect(join(directory, "resource.jsonl"), value => {
    assert.equal(value.format, 1);
    assert.equal(value.content, content);
  }, maxBytes);
let stop = false;
let reads = 0;
process.once("message", message => { assert.equal(message, "stop"); stop = true; });
assert.equal((await inspect()).revision, 1);
process.send({ type: "ready" });
await Promise.all(Array.from({ length: 4 }, async () => {
  let revision = 1;
  while (!stop) {
    const value = await inspect();
    assert.ok(value.revision >= revision);
    if (kind === "coordination") assert.equal(value.tasks[0].input, content);
    revision = value.revision;
    reads++;
  }
}));
process.send({ type: "finished", reads, revision: (await inspect()).revision });
process.disconnect();
