import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { FatalToolExecutionError, RunCancelledError } from "@may/core";
import {
  InMemoryPermissionRuleStore,
  PermissionDeniedError,
  PermissionExecutorClosedError,
  PermissionToolExecutor,
  permissionDefinitionKey,
} from "../dist/index.js";
import { FilePermissionRuleStore } from "../dist/file-store.js";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const identity = { project: "may", user: "alice", agent: "writer" };

test("execution preparation runs once while policies are reevaluated", async t => {
  const f = await fixture(t);
  let preparations = 0;
  const executor = f.executor({ beforeCheck: async check => {
    assert.equal(Object.isFrozen(check), true);
    assert.equal(Object.isFrozen(check.input), true);
    preparations += 1;
    await appendFile(join(f.directory, "preparations.txt"), `${check.context.toolCallId}\n`);
  } });
  const rule = await executor.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" });
  assert.equal(preparations, 0);
  await executor.revokeRule(rule.id);
  const pending = await request(executor, f.execution());
  await executor.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" });
  await pending.result;
  assert.equal(preparations, 1);
  await executor.execute(f.execution());
  assert.equal(preparations, 2);
  assert.equal((await readFile(join(f.directory, "preparations.txt"), "utf8")).trim().split("\n").length, 2);
});

function policy(check) {
  return {
    decision: "ask",
    grantKey: "docs-markdown",
    persistent: {
      scopeId: JSON.stringify(check.context.scope),
      description: "允许 writer 修改项目 docs 目录中的 Markdown 文件",
    },
  };
}

async function fixture(t, options = {}) {
  await mkdir(dist, { recursive: true });
  const directory = await mkdtemp(join(dist, "persistent-executor-"));
  const stores = [];
  const executors = [];
  t.after(async () => {
    for (const executor of executors) await executor.close();
    for (const store of stores) await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const openStore = async () => {
    const store = await FilePermissionRuleStore.open({ path: join(directory, "permission-rules.json") });
    stores.push(store);
    return store;
  };
  const store = options.memory ? new InMemoryPermissionRuleStore() : await openStore();
  const executor = (settings = {}) => {
    const instance = new PermissionToolExecutor({ policy, ruleStore: store, ...settings });
    executors.push(instance);
    return instance;
  };
  const execution = (settings = {}) => ({
    tool: {
      name: "write",
      description: "追加 Markdown 内容",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
      permissionVersion: "1",
      async execute(input) {
        await appendFile(input.path, input.content, "utf8");
        return readFile(input.path, "utf8");
      },
      ...settings.tool,
    },
    input: { path: join(directory, "guide.md"), content: "approved\n", ...settings.input },
    context: {
      scope: identity,
      runId: "run_persistent_permissions",
      step: 1,
      toolCallId: "call_write_markdown",
      idempotencyKey: "run_persistent_permissions:1:call_write_markdown",
      signal: new AbortController().signal,
      report() {},
      ...settings.context,
    },
  });
  return { directory, store, openStore, executor, execution };
}

async function request(instance, execution) {
  const iterator = instance.events[Symbol.asyncIterator]();
  const result = instance.execute(execution);
  let event;
  do {
    event = await iterator.next();
    assert.equal(event.done, false);
  } while (event.value.type !== "approval.requested");
  return { result, request: event.value.request };
}

async function absent(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

test("persistent approval survives executor and file store reopening", async (t) => {
  const f = await fixture(t);
  const first = f.executor();
  const events = [];
  first.setEventSink(async (event) => {
    events.push(event);
    await appendFile(join(f.directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
  });
  const operation = f.execution();
  const pending = await request(first, operation);
  assert.equal(pending.request.persistent.scopeId, JSON.stringify(identity));
  assert.equal(pending.request.persistent.definitionKey, permissionDefinitionKey(operation.tool));
  await absent(operation.input.path);
  await assert.rejects(first.resolve(pending.request.id, "allow-persistent"), /trusted createdBy/);
  assert.equal(await first.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" }), true);
  assert.equal(await pending.result, "approved\n");
  const saved = await first.listRules();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].createdBy, "local:alice");
  assert.equal(Object.hasOwn(saved[0], "input"), false);
  assert.equal(JSON.stringify(saved).includes(operation.input.path), false);
  assert.deepEqual(events.map((event) => event.type), [
    "approval.requested", "rule.created", "approval.resolved", "rule.used",
  ]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
  assert.ok(events.every((event) => Number.isSafeInteger(event.timestamp)));
  await first.close();
  await f.store.close();
  const reopened = await f.openStore();
  const second = f.executor({ ruleStore: reopened });
  const secondEvents = [];
  second.setEventSink((event) => { secondEvents.push(event); });
  assert.equal(await second.execute(f.execution()), "approved\napproved\n");
  assert.deepEqual(secondEvents.map((event) => event.type), ["rule.used"]);
});

test("persistent rules require exact user, project, agent, grant, and tool identities", async (t) => {
  const f = await fixture(t);
  const owner = f.executor();
  await owner.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" });
  const mismatches = [
    { context: { scope: { ...identity, user: "bob" } } },
    { context: { scope: { ...identity, project: "another" } } },
    { context: { scope: { ...identity, agent: "reader" } } },
    { tool: { name: "write-other" } },
    { tool: { description: "另外一种写入操作" } },
    { tool: { permissionVersion: "2" } },
    { tool: { inputSchema: { type: "object", properties: { path: { type: "string" } } } } },
  ];
  for (const changes of mismatches) {
    const instance = f.executor();
    const operation = f.execution(changes);
    const pending = await request(instance, operation);
    const rejected = assert.rejects(pending.result, PermissionDeniedError);
    await instance.resolve(pending.request.id, "deny");
    await rejected;
    await absent(operation.input.path);
  }
  const otherGrant = f.executor({ policy: (check) => ({ ...policy(check), grantKey: "another-range" }) });
  const pending = await request(otherGrant, f.execution());
  const rejected = assert.rejects(pending.result, PermissionDeniedError);
  await otherGrant.resolve(pending.request.id, "deny");
  await rejected;
  const equivalent = f.execution({ tool: {
    inputSchema: { properties: { content: { type: "string" }, path: { type: "string" } }, type: "object" },
  } });
  assert.equal(await owner.execute(equivalent), "approved\n");
});

test("persistent denial overrides policy allows, session grants, and persistent grants", async (t) => {
  const f = await fixture(t);
  let decision = "ask";
  const instance = f.executor({ policy: (check) => ({ ...policy(check), decision }) });
  const operation = f.execution();
  const pending = await request(instance, operation);
  await instance.resolve(pending.request.id, "allow-session");
  await pending.result;
  await instance.createRule(operation, { decision: "allow", createdBy: "local:alice" });
  const deny = await instance.createRule(operation, { decision: "deny", createdBy: "local:alice" });
  for (const value of ["ask", "allow"]) {
    decision = value;
    await assert.rejects(instance.execute(f.execution()), PermissionDeniedError);
  }
  assert.equal(await readFile(operation.input.path, "utf8"), "approved\n");
  assert.equal(await instance.revokeRule(deny.id), true);
  assert.equal(await instance.revokeRule(deny.id), false);
  assert.equal(await instance.execute(f.execution()), "approved\napproved\n");
});

test("revoked and expired grants request approval again", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  const granted = await instance.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" });
  await instance.revokeRule(granted.id);
  await f.store.create({ ...granted, id: "expired_rule", expiresAt: Date.now() - 1 });
  const pending = await request(instance, f.execution());
  const rejected = assert.rejects(pending.result, PermissionDeniedError);
  await instance.resolve(pending.request.id, "deny");
  await rejected;
  await absent(f.execution().input.path);
  await assert.rejects(instance.createRule(f.execution(), {
    decision: "allow", createdBy: "local:alice", expiresAt: Date.now() - 1,
  }), /future timestamp/);
});

test("requireApproval requires a fresh one-time decision and still checks deny rules", async (t) => {
  const f = await fixture(t);
  let requireApproval = false;
  const instance = f.executor({ policy: (check) => ({ ...policy(check), requireApproval }) });
  const initial = await request(instance, f.execution());
  await instance.resolve(initial.request.id, "allow-session");
  await initial.result;
  await instance.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" });
  requireApproval = true;
  const pending = await request(instance, f.execution());
  assert.equal(pending.request.grantKey, undefined);
  assert.equal(pending.request.persistent, undefined);
  await assert.rejects(instance.resolve(pending.request.id, "allow-session"), /session grant key/);
  await assert.rejects(instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" }), /does not allow persistent/);
  await instance.resolve(pending.request.id, "allow");
  assert.equal(await pending.result, "approved\napproved\n");
  await assert.rejects(instance.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" }), /does not allow/);
  await instance.createRule(f.execution(), { decision: "deny", createdBy: "local:alice" });
  await assert.rejects(instance.execute(f.execution()), PermissionDeniedError);
});

test("persistent approval requires a configured store and trusted policy scope", async (t) => {
  const f = await fixture(t);
  for (const options of [{ ruleStore: undefined }, { policy: () => ({ decision: "ask", grantKey: "write" }) }]) {
    const instance = f.executor(options);
    const pending = await request(instance, f.execution());
    assert.equal(pending.request.persistent, undefined);
    await assert.rejects(instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" }), /does not allow persistent/);
    await instance.resolve(pending.request.id, "allow");
    await pending.result;
  }
  assert.equal((await f.store.list()).length, 0);
});

test("session grants cannot cross trusted persistent scopes", async (t) => {
  const f = await fixture(t, { memory: true });
  const instance = f.executor();
  const first = await request(instance, f.execution());
  await instance.resolve(first.request.id, "allow-session");
  await first.result;
  const pending = await request(instance, f.execution({ context: { scope: { ...identity, user: "bob" } } }));
  const rejected = assert.rejects(pending.result, PermissionDeniedError);
  await instance.resolve(pending.request.id, "deny");
  await rejected;
  assert.equal(await readFile(f.execution().input.path, "utf8"), "approved\n");
  assert.equal(instance.revokeSessionGrant("docs-markdown"), true);
  assert.equal(instance.revokeSessionGrant("docs-markdown"), false);
  const owner = await request(instance, f.execution());
  const ownerRejected = assert.rejects(owner.result, PermissionDeniedError);
  await instance.resolve(owner.request.id, "deny");
  await ownerRejected;
});

test("pending approval rechecks policy denials and changed scopes", async (t) => {
  const f = await fixture(t);
  for (const approval of ["allow", "allow-persistent"]) {
    for (const change of ["deny", "scope"]) {
      let changed = false;
      const instance = f.executor({ policy(check) {
        if (changed && change === "deny") return "deny";
        const result = policy(check);
        if (changed) result.persistent.scopeId = "another-project";
        return result;
      } });
      const pending = await request(instance, f.execution());
      const rejected = assert.rejects(pending.result, PermissionDeniedError);
      changed = true;
      if (approval === "allow-persistent") {
        await assert.rejects(instance.resolve(pending.request.id, approval, { createdBy: "local:alice" }), PermissionDeniedError);
      } else {
        await instance.resolve(pending.request.id, approval);
      }
      await rejected;
      await absent(f.execution().input.path);
    }
  }
  assert.equal((await f.store.list()).length, 0);
});

test("pending approval checks denials added during rule persistence", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  instance.setEventSink(async (event) => {
    await appendFile(join(f.directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    if (event.type === "rule.created" && event.rule.decision === "allow") {
      await instance.createRule(f.execution(), { decision: "deny", createdBy: "local:alice" });
    }
  });
  const pending = await request(instance, f.execution());
  const rejected = assert.rejects(pending.result, PermissionDeniedError);
  await instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" });
  await rejected;
  await absent(f.execution().input.path);
});

test("revocation during rule-created and rule-used persistence prevents execution", async (t) => {
  const f = await fixture(t);
  for (const phase of ["rule.created", "rule.used"]) {
    const instance = f.executor();
    instance.setEventSink(async (event) => {
      if (event.type === phase && (event.type !== "rule.created" || event.rule.decision === "allow")) {
        await instance.revokeRule(event.type === "rule.created" ? event.rule.id : event.ruleId);
      }
    });
    const pending = await request(instance, f.execution());
    const rejected = assert.rejects(pending.result, PermissionDeniedError);
    await instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" });
    await rejected;
    await absent(f.execution().input.path);
  }
});

test("closing or aborting while saving the rule event prevents execution", async (t) => {
  const f = await fixture(t);
  for (const action of ["close", "abort"]) {
    const controller = new AbortController();
    const instance = f.executor();
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    instance.setEventSink(async (event) => {
      await appendFile(join(f.directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
      if (event.type === "rule.created") {
        started.resolve();
        await release.promise;
      }
    });
    const pending = await request(instance, f.execution({ context: { signal: controller.signal } }));
    const errorType = action === "close" ? PermissionExecutorClosedError : RunCancelledError;
    const rejected = assert.rejects(pending.result, errorType);
    const resolution = instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" });
    const resolutionRejected = assert.rejects(resolution, errorType);
    await started.promise;
    if (action === "close") await instance.close("宿主关闭");
    else controller.abort("用户取消");
    release.resolve();
    await resolutionRejected;
    await rejected;
    await absent(f.execution().input.path);
    for (const rule of await f.store.list()) await f.store.revoke(rule.id);
  }
});

test("real store corruption prevents an allowed tool from executing", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  await instance.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" });
  await writeFile(f.store.path, "{invalid-json", "utf8");
  await assert.rejects(instance.execute(f.execution()), FatalToolExecutionError);
  await absent(f.execution().input.path);
});

test("a closed rule store prevents pending persistent approval from executing", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  const pending = await request(instance, f.execution());
  const rejected = assert.rejects(pending.result, /store is closed/);
  await f.store.close();
  await assert.rejects(instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" }), /store is closed/);
  await rejected;
  await absent(f.execution().input.path);
});

test("a readonly Windows rule file prevents persistent approval from executing", { skip: process.platform !== "win32" }, async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  const pending = await request(instance, f.execution());
  const rejected = assert.rejects(pending.result, /EPERM|EACCES/);
  await chmod(f.store.path, 0o444);
  try {
    await assert.rejects(instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" }), /EPERM|EACCES/);
    await rejected;
    await absent(f.execution().input.path);
  } finally {
    await chmod(f.store.path, 0o600);
  }
});

test("rule event persistence failures use actual filesystem errors and prevent execution", async (t) => {
  const f = await fixture(t);
  for (const phase of ["rule.created", "rule.used"]) {
    const instance = f.executor();
    instance.setEventSink(async (event) => {
      if (event.type === phase) {
        await appendFile(join(f.directory, "absent", "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
      }
    });
    const pending = await request(instance, f.execution());
    const rejected = assert.rejects(pending.result, /Permission event persistence failed/);
    if (phase === "rule.created") {
      await assert.rejects(instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" }), /Permission event persistence failed/);
    } else {
      await instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:alice" });
    }
    await rejected;
    await absent(f.execution().input.path);
    for (const rule of await f.store.list()) await f.store.revoke(rule.id);
  }
});

test("cancelled request-event persistence completes without exposing a pending request", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const controller = new AbortController();
  instance.setEventSink(async (event) => {
    await appendFile(join(f.directory, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    if (event.type === "approval.requested") {
      started.resolve();
      await release.promise;
    }
  });
  const result = instance.execute(f.execution({ context: { signal: controller.signal } }));
  const rejected = assert.rejects(result, RunCancelledError);
  await started.promise;
  controller.abort("用户取消");
  await rejected;
  release.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  await instance.close();
  const events = [];
  for await (const event of instance.events) events.push(event.type);
  assert.deepEqual(events, ["approval.cancelled"]);
  await absent(f.execution().input.path);
});

test("concurrent resolution stores exactly one rule and snapshots the approver identity", async (t) => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let checks = 0;
  const instance = f.executor({ async policy(check) {
    if (++checks === 2) {
      started.resolve();
      await release.promise;
    }
    return policy(check);
  } });
  const pending = await request(instance, f.execution());
  const options = { createdBy: "local:alice" };
  const first = instance.resolve(pending.request.id, "allow-persistent", options);
  await started.promise;
  options.createdBy = "";
  assert.equal(await instance.resolve(pending.request.id, "allow-persistent", { createdBy: "local:bob" }), false);
  release.resolve();
  assert.equal(await first, true);
  await pending.result;
  const rules = await instance.listRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].createdBy, "local:alice");
});

test("tool definitions changed during pending approval cannot use the original authorization", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  const operation = f.execution();
  const pending = await request(instance, operation);
  const rejected = assert.rejects(pending.result, PermissionDeniedError);
  operation.tool.permissionVersion = "2";
  await instance.resolve(pending.request.id, "allow");
  await rejected;
  await absent(operation.input.path);
});

test("host rule creation from an existing source retains only its trusted operation range", async (t) => {
  const f = await fixture(t);
  const instance = f.executor();
  const allowed = await instance.createRule(f.execution(), { decision: "allow", createdBy: "local:alice" });
  const deny = await instance.createRuleFrom(allowed.id, { decision: "deny", createdBy: "local:admin" });
  assert.notEqual(deny.id, allowed.id);
  assert.equal(deny.createdBy, "local:admin");
  for (const key of ["scopeId", "toolName", "definitionKey", "grantKey", "description"]) {
    assert.equal(deny[key], allowed[key]);
  }
  await assert.rejects(instance.execute(f.execution()), PermissionDeniedError);
  await absent(f.execution().input.path);
  await instance.revokeRule(allowed.id);
  await instance.revokeRule(deny.id);
  await assert.rejects(instance.createRuleFrom(allowed.id, { decision: "allow", createdBy: "local:admin" }), /does not exist/);
  await assert.rejects(instance.createRuleFrom("unknown", { decision: "allow", createdBy: "" }), /trusted createdBy/);
  await assert.rejects(instance.createRuleFrom("unknown", {
    decision: "allow", createdBy: "local:admin", expiresAt: Date.now() - 1,
  }), /future timestamp/);
});
