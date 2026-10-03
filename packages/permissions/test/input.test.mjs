import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FatalToolExecutionError } from "@may/core";
import { PermissionToolExecutor } from "../dist/index.js";

class ReadInput {
  constructor() {
    this.path = fileURLToPath(new URL("../README.md", import.meta.url));
    this.options = { encoding: "utf8" };
  }
  getPath() { return this.path; }
}

function readExecution(input, progress) {
  return {
    tool: {
      name: "read_permission_document",
      description: "Read the permission package documentation",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      async execute(arguments_, context) {
        assert.ok(arguments_ instanceof ReadInput);
        assert.equal(arguments_.getPath(), arguments_.path);
        assert.ok(Object.isFrozen(arguments_));
        assert.ok(Object.isFrozen(arguments_.options));
        assert.throws(() => { arguments_.path = "another.md"; }, TypeError);
        context.report({ type: "progress", message: "Reading permission documentation" });
        return readFile(arguments_.path, arguments_.options.encoding);
      },
    },
    input,
    context: {
      runId: "run_permission_document",
      step: 1,
      toolCallId: "call_permission_document",
      idempotencyKey: "run_permission_document:1:call_permission_document",
      signal: new AbortController().signal,
      report(update) { progress.push(update); },
    },
  };
}

test("permission policies and actual file readers receive immutable arguments", async () => {
  const input = new ReadInput();
  const progress = [];
  let policyCalls = 0;
  const permissions = new PermissionToolExecutor({
    policy(check) {
      policyCalls += 1;
      assert.notEqual(check.input, input);
      assert.deepEqual(check.input, { path: input.path, options: input.options });
      assert.ok(Object.isFrozen(check));
      assert.ok(Object.isFrozen(check.input));
      assert.ok(Object.isFrozen(check.input.options));
      assert.ok(Object.isFrozen(check.tool));
      assert.ok(Object.isFrozen(check.tool.inputSchema.properties));
      assert.throws(() => { check.input.options.encoding = "base64"; }, TypeError);
      assert.throws(() => { check.tool.inputSchema.properties.path.type = "number"; }, TypeError);
      return "allow";
    },
  });
  try {
    const content = await permissions.execute(readExecution(input, progress));
    assert.ok(content.startsWith("# `@may/permissions`"));
    assert.equal(policyCalls, 1);
    assert.equal(progress.length, 1);
    assert.equal(input.options.encoding, "utf8");
  } finally {
    await permissions.close();
  }
});

test("mutable built-in arguments are rejected before permission evaluation", async () => {
  let policyCalls = 0;
  const permissions = new PermissionToolExecutor({ policy() { policyCalls += 1; return "allow"; } });
  const progress = [];
  try {
    for (const value of [new Date(), new Map(), new Set()]) {
      const input = new ReadInput();
      input.value = value;
      await assert.rejects(permissions.execute(readExecution(input, progress)), (error) => {
        assert.ok(error instanceof FatalToolExecutionError);
        assert.ok(error.cause instanceof TypeError);
        assert.match(error.cause.message, /mutable built-in/);
        return true;
      });
      assert.equal(Object.isFrozen(input), false);
    }
    assert.equal(policyCalls, 0);
    assert.deepEqual(progress, []);
  } finally {
    await permissions.close();
  }
});
