import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryContext,
  HookExecutionError,
  RUNTIME_HOOKS,
  ToolRegistry,
  defineHook,
  freezeToolInput,
  runtimeHooks,
  userMessage,
  validateRuntimeDescriptor,
} from "../dist/index.js";

test("runtime Hook definitions validate actual Context snapshots and registry definitions", async () => {
  const context = new InMemoryContext({ instructions: "Inspect the project", messages: [userMessage("Read package.json")] });
  const snapshot = await context.snapshot();
  assert.equal(runtimeHooks.contextAfter.validate(snapshot), snapshot);
  const registry = new ToolRegistry();
  const request = { messages: snapshot.messages, tools: registry.definitions() };
  assert.equal(runtimeHooks.modelBefore.validate(request), request);
  assert.equal(new Set(RUNTIME_HOOKS.map((hook) => hook.name)).size, RUNTIME_HOOKS.length);
  assert.ok(Object.isFrozen(runtimeHooks));
  assert.ok(RUNTIME_HOOKS.every(Object.isFrozen));
});

test("Hook validators reject invalid transformed messages and malformed content", () => {
  assert.throws(() => runtimeHooks.contextAfter.validate({ messages: [{ role: "user", content: [{ type: "text", text: 7 }] }] }), TypeError);
  assert.throws(() => runtimeHooks.contextAfter.validate({ messages: [{ role: "tool", content: [], toolCallId: "", name: "read" }] }), TypeError);
  assert.throws(() => runtimeHooks.modelBefore.validate({ messages: [], tools: [{ name: "read", description: "Read", inputSchema: {} }, { name: "read", description: "Read", inputSchema: {} }] }), /unique names/);
  assert.throws(() => runtimeHooks.modelEvent.validate({ type: "response.completed", message: userMessage("Invalid response role") }), /assistant/);
  assert.throws(() => runtimeHooks.contextAfter.validate({ messages: [{ role: "assistant", content: [], toolCalls: [{ id: "read", name: "read", input: {} }, { id: "read", name: "read", input: {} }] }] }), /unique identities/);
  assert.throws(() => runtimeHooks.contextAfter.validate({ messages: [{ role: "assistant", content: [], toolCalls: [{ id: "read", name: "read", input: {} }] }] }), /without results/);
  assert.throws(() => runtimeHooks.contextAfter.validate({ messages: [{ role: "assistant", content: [], toolCalls: [{ id: "read", name: "read", input: {} }] }, { role: "tool", toolCallId: "write", name: "write", content: [] }] }), /unresolved assistant call/);
});

test("continued execution requires user messages and an explicit reason", () => {
  const result = { runId: "run_validation", steps: 1, modelCalls: 1, toolCalls: 0, message: { role: "assistant", content: [] } };
  assert.throws(() => runtimeHooks.runBeforeEnd.validate({ result, continueMessages: [userMessage("Complete validation")] }), /Continuation reason/);
  assert.throws(() => runtimeHooks.runBeforeEnd.validate({ result, continueMessages: [{ role: "system", content: [] }], reason: "Complete validation" }), /user messages/);
  const settlement = { result, continueMessages: [userMessage("Complete validation")], reason: "Verification is incomplete" };
  assert.equal(runtimeHooks.runBeforeEnd.validate(settlement), settlement);
});

test("Hook kinds and runtime state identities fail at definition validation", () => {
  assert.throws(() => defineHook({ name: "input.transform", kind: "transform", validate: (value) => value, failure: "isolate" }), /must propagate/);
  assert.throws(() => defineHook({ name: "", kind: "observe", validate: (value) => value }), /empty/);
  assert.throws(() => validateRuntimeDescriptor({ id: "workflow", version: "1", stateVersion: 0 }), /positive/);
  assert.throws(() => validateRuntimeDescriptor({ id: "workflow", version: "" }), /empty/);
  validateRuntimeDescriptor({ id: "workflow", version: "1", stateVersion: 1 });
  assert.equal(runtimeHooks.runFailed.allowAborted, true);
  assert.equal(runtimeHooks.modelFailed.allowAborted, true);
});

test("Hook execution errors retain control identity and original evidence", () => {
  const cause = new Error("Context compaction is disabled by the active policy");
  const error = new HookExecutionError(cause, "context.compaction.before");
  assert.equal(error.code, "HOOK_EXECUTION_FAILED");
  assert.equal(error.hookName, "context.compaction.before");
  assert.equal(error.cause, cause);
});

test("final tool arguments retain parsed classes and protect nested data", () => {
  class ParsedInput {
    constructor(path) { this.path = path; this.options = { segments: ["packages", "core"] }; }
    getPath() { return this.path; }
  }
  const input = new ParsedInput("package.json");
  const symbol = Symbol("identity");
  input[symbol] = { value: "read" };
  input.self = input;
  assert.equal(freezeToolInput(input), input);
  assert.ok(input instanceof ParsedInput);
  assert.equal(input.getPath(), "package.json");
  assert.ok(Object.isFrozen(input));
  assert.ok(Object.isFrozen(input.options));
  assert.ok(Object.isFrozen(input.options.segments));
  assert.ok(Object.isFrozen(input[symbol]));
  assert.throws(() => { input.path = "another.json"; }, TypeError);
  assert.throws(() => { input.options.segments.push("session"); }, TypeError);
});

test("mutable built-in tool arguments fail before fields are frozen", () => {
  for (const value of [new Date(), new Map(), new Set(), new WeakMap(), new WeakSet(), new ArrayBuffer(8), new Uint8Array(8), new URL("https://example.com"), new URLSearchParams("name=may")]) {
    const input = { value };
    assert.throws(() => freezeToolInput(input), /mutable built-in/);
    assert.equal(Object.isFrozen(input), false);
  }
});
