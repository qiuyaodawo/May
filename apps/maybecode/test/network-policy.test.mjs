import assert from "node:assert/strict";
import test from "node:test";
import { createFetchTool, createGlobTool, createGrepTool } from "@sortedyuan/coding-tools";
import { createCodingPermissionPolicy } from "../dist/policy.js";

test("network grants use origins and follow permission mode", async () => {
  const tool = createFetchTool({});
  const check = { tool, input: { url: "https://example.com/guide?value=1" } };
  const normal = createCodingPermissionPolicy();
  assert.deepEqual(await normal(check), { decision: "ask", grantKey: "network:https://example.com" });
  const yolo = createCodingPermissionPolicy({ mode: () => "yolo" });
  assert.equal((await yolo(check)).decision, "allow");
  const denied = createCodingPermissionPolicy({ mode: () => "yolo", policy: () => "deny" });
  assert.equal(await denied(check), "deny");
  const persistent = createCodingPermissionPolicy({ persistent: { workspace: process.cwd(), scopeId: "network" } });
  assert.deepEqual(await persistent(check), {
    decision: "ask",
    grantKey: "network:https://example.com",
    persistent: { scopeId: "network", description: "network · https://example.com" },
  });
});

test("workspace searches share read permissions", async () => {
  const policy = createCodingPermissionPolicy({ readOnly: true });
  for (const tool of [createGlobTool({ cwd: process.cwd() }), createGrepTool({ cwd: process.cwd() })]) {
    assert.equal(await policy({ tool, input: { pattern: "value" } }), "allow");
  }
  assert.equal(await policy({ tool: createFetchTool({}), input: { url: "https://example.com" } }), "deny");
});
