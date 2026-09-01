import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openConfiguredMaybeCode } from "../../dist/index.js";

test("runs and resumes a real DeepSeek coding session", async (t) => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "maybecode-live-"));
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const workspace = fileURLToPath(new URL("../../../..", import.meta.url));

  const first = await openConfiguredMaybeCode({
    workspace,
    dataDirectory,
    autoResume: false,
    maxSteps: 8,
  });
  const firstEvents = collectAndApprove(first);
  const firstRun = await first.submit({
    input: "Use the read tool to read README.md, then answer with only its first Markdown heading. Do not use shell.",
  });
  const firstResult = await firstRun.result;
  const sessionId = first.sessionId;
  await first.close();
  const observedFirst = await firstEvents;

  assert.match(textOf(firstResult.message), /May/u);
  assert.ok(
    observedFirst.some((event) =>
      event.type === "run.event" &&
      event.event.type === "tool.completed" &&
      event.event.call.name === "read"
    ),
  );

  const resumed = await openConfiguredMaybeCode({ workspace, dataDirectory });
  assert.equal(resumed.sessionId, sessionId);
  const resumedEvents = collectAndApprove(resumed);
  const secondResult = await (await resumed.submit({
    input: "Reply with exactly CONTEXT_OK if the previous request asked you to read README.md.",
  })).result;
  await resumed.close();
  await resumedEvents;

  assert.match(textOf(secondResult.message), /CONTEXT_OK/u);
});

async function collectAndApprove(app) {
  const events = [];
  for await (const event of app.events) {
    events.push(event);
    if (
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ) {
      await app.resolveApproval(event.event.request.id, "allow");
    }
  }
  return events;
}

function textOf(message) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}
