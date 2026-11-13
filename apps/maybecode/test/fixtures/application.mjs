import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

export async function collectEvents(app, target, approvalDecision) {
  for await (const event of app.events) {
    target.push(event);
    if (event.type === "permission.event" && event.event.type === "approval.requested") {
      await app.resolveApproval(event.event.request.id, approvalDecision);
    }
  }
}

export async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybecode-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
