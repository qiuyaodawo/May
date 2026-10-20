import assert from "node:assert/strict";
import { once } from "node:events";
import { open, readFile } from "node:fs/promises";
import { withFileAccess } from "@sortedyuan/session/file-access";
import { runMaybeCodeTeamCommand } from "../../dist/team.js";

const [job] = await once(process, "message");
process.send({ type: "ready" });
await once(process, "message");
if (job.kind === "partial-manifest") {
  await withFileAccess(job.path, "exclusive", async () => {
    const file = await open(job.path, "wx");
    try {
      const bytes = Buffer.from(JSON.stringify(job.manifest));
      const split = Math.floor(bytes.length / 2);
      await file.write(bytes, 0, split, 0);
      process.send({ type: "partial" });
      await once(process, "message");
      await file.write(bytes, split, bytes.length - split, split);
      await file.sync();
    } finally { await file.close(); }
  });
} else {
  process.send({ type: "started" });
  for (let index = 0; index < job.count; index++) {
    if (job.kind === "read-cancellation") {
      const value = await withFileAccess(job.path, "shared", async () => JSON.parse(await readFile(job.path, "utf8")));
      assert.equal(value.id, job.id);
      assert.equal(typeof value.requestedAt, "string");
    } else {
      let output = "";
      assert.equal(await runMaybeCodeTeamCommand(job.command, { write: text => { output += text; } }), job.exitCode);
      if (job.command.action === "status") {
        assert.ok(output.includes(`Team ${job.command.value}\n`), output);
        if (job.version === "v2" && !job.initialManifest) {
          const prefix = "Last acceptance projection (may be stale): ";
          assert.ok(output.includes(prefix), output);
          const projection = JSON.parse(output.slice(output.indexOf(prefix) + prefix.length));
          assert.equal(projection.format, 1);
          assert.equal(projection.status, "unverified");
        } else if (job.version === "v1") {
          assert.match(output, /summary: cancelled/u);
        }
      }
    }
  }
}
process.send({ type: "done" });
process.disconnect();
