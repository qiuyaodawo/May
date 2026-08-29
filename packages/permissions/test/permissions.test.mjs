import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryContext,
  May,
  RunCancelledError,
} from "@may/core";
import {
  PermissionDeniedError,
  PermissionExecutorClosedError,
  PermissionToolExecutor,
} from "../dist/index.js";

test("allows a tool and delegates its parsed input", async () => {
  let modelCall = 0;
  let checkedInput;
  let executedInput;
  const permissions = new PermissionToolExecutor({
    policy(check) {
      checkedInput = check.input;
      return "allow";
    },
  });
  const model = {
    async *stream() {
      modelCall += 1;
      if (modelCall === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [
              { id: "call_add", name: "add", input: { value: "2" } },
            ],
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage("done"),
      };
    },
  };
  const may = new May({
    model,
    context: new InMemoryContext(),
    toolExecutor: permissions,
    tools: [
      {
        name: "add",
        description: "Add a value",
        inputSchema: { type: "object" },
        parse(input) {
          return { value: Number(input.value) };
        },
        async execute(input) {
          executedInput = input;
          return input.value + 1;
        },
      },
    ],
  });

  const result = await may.run({ input: "add" }).result;

  assert.equal(result.message.content[0].text, "done");
  assert.deepEqual(checkedInput, { value: 2 });
  assert.deepEqual(executedInput, { value: 2 });
});

test("denies a tool without invoking it", async () => {
  let executed = false;
  const permissions = new PermissionToolExecutor({
    policy: () => "deny",
  });

  await assert.rejects(
    permissions.execute(createExecution({
      execute: async () => {
        executed = true;
        return "unreachable";
      },
    })),
    (error) => {
      assert.ok(error instanceof PermissionDeniedError);
      assert.equal(error.code, "PERMISSION_DENIED");
      assert.equal(error.toolName, "bash");
      return true;
    },
  );
  assert.equal(executed, false);
});

test("asks for approval and resumes after an allow response", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());

  const requested = (await iterator.next()).value;
  assert.equal(requested.type, "approval.requested");
  assert.equal(requested.request.tool.name, "bash");
  assert.deepEqual(requested.request.input, { command: "pwd" });
  assert.equal(await permissions.resolve(requested.request.id, "allow"), true);

  assert.equal(await resultPromise, "executed");
  const resolved = (await iterator.next()).value;
  assert.equal(resolved.type, "approval.resolved");
  assert.equal(resolved.requestId, requested.request.id);
  assert.equal(resolved.decision, "allow");
  await permissions.close();
});

test("waits for its event sink before resuming an approved tool", async () => {
  let releaseSink;
  const sinkGate = new Promise((resolve) => {
    releaseSink = resolve;
  });
  const recorded = [];
  let executed = false;
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  permissions.setEventSink(async (event) => {
    recorded.push(event.type);
    if (event.type === "approval.resolved") await sinkGate;
  });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution({
    execute: async () => {
      executed = true;
      return "executed";
    },
  }));
  const requested = (await iterator.next()).value;

  const resolution = permissions.resolve(requested.request.id, "allow");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed, false);

  releaseSink();
  assert.equal(await resolution, true);
  assert.equal(await resultPromise, "executed");
  assert.deepEqual(recorded, ["approval.requested", "approval.resolved"]);
  await permissions.close();
});

test("does not request approval when its event sink fails", async () => {
  let executed = false;
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  permissions.setEventSink(() => {
    throw new Error("request storage failed");
  });

  await assert.rejects(
    permissions.execute(createExecution({
      execute: async () => {
        executed = true;
      },
    })),
    /request storage failed/,
  );
  assert.equal(executed, false);
  await permissions.close();
});

test("does not resume a tool when storing its resolution fails", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  permissions.setEventSink((event) => {
    if (event.type === "approval.resolved") {
      throw new Error("resolution storage failed");
    }
  });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;
  const rejected = assert.rejects(resultPromise, /resolution storage failed/);

  await assert.rejects(
    permissions.resolve(requested.request.id, "allow"),
    /resolution storage failed/,
  );
  await rejected;
  await permissions.close();
});

test("reports cancellation storage failures while closing", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  permissions.setEventSink((event) => {
    if (event.type === "approval.cancelled") {
      throw new Error("cancellation storage failed");
    }
  });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());
  await iterator.next();
  const rejected = assert.rejects(resultPromise, /cancellation storage failed/);

  await assert.rejects(
    permissions.close("session ended"),
    /cancellation storage failed/,
  );
  await rejected;
});

test("reuses an explicitly scoped session approval", async () => {
  const permissions = new PermissionToolExecutor({
    policy: () => ({ decision: "ask", grantKey: "bash:pwd" }),
  });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const firstResult = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;

  assert.equal(requested.request.grantKey, "bash:pwd");
  assert.equal(
    await permissions.resolve(requested.request.id, "allow-session"),
    true,
  );
  assert.equal(await firstResult, "executed");
  assert.equal((await iterator.next()).value.decision, "allow-session");

  assert.equal(await permissions.execute(createExecution()), "executed");
  await permissions.close();
  assert.equal((await iterator.next()).done, true);
});

test("requires an explicit grant key for allow-session", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;

  assert.throws(
    () => permissions.resolve(requested.request.id, "allow-session"),
    /does not define a session grant key/,
  );
  assert.equal(await permissions.resolve(requested.request.id, "allow"), true);
  assert.equal(await resultPromise, "executed");
  await permissions.close();
});

test("does not let a session grant override a later denial", async () => {
  let decision = { decision: "ask", grantKey: "bash:pwd" };
  const permissions = new PermissionToolExecutor({ policy: () => decision });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const firstResult = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;
  await permissions.resolve(requested.request.id, "allow-session");
  await firstResult;

  decision = "deny";
  await assert.rejects(
    permissions.execute(createExecution()),
    PermissionDeniedError,
  );
  await permissions.close();
});

test("can revoke a session grant", async () => {
  const permissions = new PermissionToolExecutor({
    policy: () => ({ decision: "ask", grantKey: "bash:pwd" }),
  });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const firstResult = permissions.execute(createExecution());
  const firstRequest = (await iterator.next()).value.request;
  await permissions.resolve(firstRequest.id, "allow-session");
  await firstResult;
  await iterator.next();

  assert.equal(permissions.revokeSessionGrant("bash:pwd"), true);
  assert.equal(permissions.revokeSessionGrant("bash:pwd"), false);

  const secondResult = permissions.execute(createExecution());
  const secondRequest = (await iterator.next()).value.request;
  await permissions.resolve(secondRequest.id, "allow");
  assert.equal(await secondResult, "executed");
  await permissions.close();
});

test("rejects an asked tool after a deny response", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;
  const rejected = assert.rejects(resultPromise, PermissionDeniedError);

  assert.equal(await permissions.resolve(requested.request.id, "deny"), true);
  await rejected;
  assert.equal((await iterator.next()).value.decision, "deny");
  await permissions.close();
});

test("cancels a pending approval when its run is cancelled", async () => {
  const controller = new AbortController();
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution({
    signal: controller.signal,
  }));
  const requested = (await iterator.next()).value;
  const rejected = assert.rejects(resultPromise, RunCancelledError);

  controller.abort("user stopped");

  await rejected;
  const cancelled = (await iterator.next()).value;
  assert.equal(cancelled.type, "approval.cancelled");
  assert.equal(cancelled.requestId, requested.request.id);
  assert.equal(cancelled.reason, "user stopped");
  assert.equal(await permissions.resolve(requested.request.id, "allow"), false);
  await permissions.close();
});

test("rejects before policy evaluation when already cancelled", async () => {
  for (const reason of [new Error("already stopped"), 42]) {
    const controller = new AbortController();
    let checked = false;
    const permissions = new PermissionToolExecutor({
      policy() {
        checked = true;
        return "allow";
      },
    });
    controller.abort(reason);

    await assert.rejects(
      permissions.execute(createExecution({ signal: controller.signal })),
      RunCancelledError,
    );
    assert.equal(checked, false);
    await permissions.close();
  }
});

test("closing rejects pending and future approvals and closes events", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;
  const rejected = assert.rejects(
    resultPromise,
    PermissionExecutorClosedError,
  );

  await permissions.close("session ended");

  await rejected;
  const cancelled = (await iterator.next()).value;
  assert.equal(cancelled.type, "approval.cancelled");
  assert.equal(cancelled.requestId, requested.request.id);
  assert.equal(cancelled.reason, "session ended");
  assert.equal((await iterator.next()).done, true);
  await assert.rejects(
    permissions.execute(createExecution()),
    PermissionExecutorClosedError,
  );
});

test("turns a policy denial into a tool failure that the model can recover from", async () => {
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [
              { id: "call_bash", name: "bash", input: { command: "pwd" } },
            ],
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage("I cannot run that command."),
      };
    },
  };
  const may = new May({
    model,
    context: new InMemoryContext(),
    toolExecutor: new PermissionToolExecutor({ policy: () => "deny" }),
    tools: [createExecution().tool],
  });

  const result = await may.run({ input: "run pwd" }).result;
  const toolMessage = requests[1].messages.find(
    (message) => message.role === "tool",
  );

  assert.equal(result.message.content[0].text, "I cannot run that command.");
  assert.equal(toolMessage.isError, true);
  assert.equal(toolMessage.content[0].value.code, "PERMISSION_DENIED");
});

test("rejects an invalid policy decision", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "later" });

  await assert.rejects(
    permissions.execute(createExecution()),
    /Invalid permission decision: later/,
  );
  await permissions.close();
  await permissions.close();
});

test("rejects an empty session grant key", async () => {
  const permissions = new PermissionToolExecutor({
    policy: () => ({ decision: "ask", grantKey: " " }),
  });

  await assert.rejects(
    permissions.execute(createExecution()),
    /Invalid session grant key/,
  );
  await permissions.close();
});

test("rejects an invalid approval response without resolving the request", async () => {
  const permissions = new PermissionToolExecutor({ policy: () => "ask" });
  const iterator = permissions.events[Symbol.asyncIterator]();
  const resultPromise = permissions.execute(createExecution());
  const requested = (await iterator.next()).value;

  assert.throws(
    () => permissions.resolve(requested.request.id, "ask"),
    /Invalid approval decision: ask/,
  );
  assert.equal(await permissions.resolve(requested.request.id, "allow"), true);
  assert.equal(await resultPromise, "executed");
  await permissions.close();
});

test("can delegate allowed calls through another executor", async () => {
  let delegated;
  const permissions = new PermissionToolExecutor({
    policy: async () => "allow",
    executor: {
      async execute(execution) {
        delegated = execution;
        return "wrapped";
      },
    },
  });
  const execution = createExecution();

  assert.equal(await permissions.execute(execution), "wrapped");
  assert.equal(delegated, execution);
});

function createExecution(options = {}) {
  const controller = new AbortController();
  return {
    tool: {
      name: "bash",
      description: "Run a command",
      inputSchema: { type: "object" },
      execute: options.execute ?? (async () => "executed"),
    },
    input: { command: "pwd" },
    context: {
      runId: "run_test",
      step: 1,
      toolCallId: "call_test",
      idempotencyKey: "run_test:1:call_test",
      signal: options.signal ?? controller.signal,
      report() {},
    },
  };
}

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
