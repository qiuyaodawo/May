import { createTestDirectory } from "@sortedyuan/test-support";

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

export function temporaryDirectory(t) {
  return createTestDirectory(t, "maybecode/config");
}
