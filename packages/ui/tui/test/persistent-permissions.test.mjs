import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryPermissionRuleStore, PermissionToolExecutor } from "../../../permissions/dist/index.js";
import { TranscriptStore, TranscriptView } from "../dist/agent/transcript.js";

test("terminal transcript retains persistent approval range from real permission events", async t => {
  const verificationDirectory = fileURLToPath(new URL("../../../../plugin-verification/persistent-terminal/", import.meta.url));
  await mkdir(verificationDirectory, { recursive: true });
  const root = await mkdtemp(join(verificationDirectory, "run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "guide.md"), description = "Modify Markdown files under project docs", scopeId = "project:may:agent:writer";
  const permissions = new PermissionToolExecutor({ ruleStore: new InMemoryPermissionRuleStore(), policy: () => ({ decision: "ask", grantKey: "docs-markdown", persistent: { scopeId, description } }) });
  t.after(() => permissions.close());
  const events = permissions.events[Symbol.asyncIterator]();
  const operation = permissions.execute({ tool: { name: "write", description: "Write Markdown", inputSchema: { type: "object" }, async execute(input) { await writeFile(path, input.text); return path; } }, input: { text: "# Rules\n" },
    context: { runId: "file-write", step: 1, toolCallId: "call", idempotencyKey: "call", signal: new AbortController().signal, report() {} },
  });
  const request = (await events.next()).value;
  assert.equal(request.type, "approval.requested");
  const store = new TranscriptStore();
  store.applyPermissionEvent(request);
  assert.equal(store.items[0].scopeDescription, description);
  assert.equal(store.items[0].scopeId, scopeId);
  const view = new TranscriptView(store);
  assert.match(view.render({ width: 150, height: 15 }).lines.join("\n"), /Modify Markdown files under project docs/u);
  await permissions.resolve(request.request.id, "allow-persistent", { createdBy: "local-operator" });
  let resolved = false;
  while (!resolved) {
    const event = (await events.next()).value;
    store.applyPermissionEvent(event);
    resolved = event.type === "approval.resolved";
  }
  assert.equal(await operation, path);
  assert.equal(await readFile(path, "utf8"), "# Rules\n");
  assert.equal(store.items.length, 1);
  assert.equal(store.items[0].decision, "allow-persistent");
  assert.match(view.render({ width: 150, height: 15 }).lines.join("\n"), /project:may:agent:writer/u);
});
