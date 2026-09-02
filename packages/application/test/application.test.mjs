import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentApplication,
  AgentWorkspace,
  AsyncStateSerializer,
} from "../dist/index.js";
import { InMemorySessionCatalog } from "../../session/dist/catalog.js";
import { InMemorySessionStore } from "../../session/dist/index.js";

function assistant(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

test("AgentApplication owns durable run, retry, and event lifecycles", async () => {
  let attempt = 0;
  const model = {
    async *stream() {
      attempt += 1;
      if (attempt === 1) throw new Error("temporary failure");
      yield {
        type: "response.completed",
        message: assistant("recovered"),
        usage: { inputTokens: 7 },
      };
    },
  };
  const store = new InMemorySessionStore();
  const application = await AgentApplication.open({
    model,
    store,
    instructions: "Answer briefly.",
    permissionPolicy: () => "allow",
    sessionHistory: {},
  });
  const events = [];
  const relay = (async () => {
    for await (const event of application.events) events.push(event);
  })();

  await assert.rejects((await application.submit({ input: "hello" })).result, {
    message: "temporary failure",
  });
  const result = await (await application.retry()).result;
  assert.equal(result.message.content[0].text, "recovered");

  const history = await application.history();
  assert.equal(
    history.filter((event) => event.type === "input.submitted").length,
    1,
  );
  assert.equal(
    history.filter((event) => event.type === "run.started")[1].continuation,
    true,
  );
  assert.deepEqual(
    (await application.queryHistory({ types: ["run.failed"] })).events.map(
      (event) => event.type,
    ),
    ["run.failed"],
  );

  await application.close();
  await relay;
  assert.equal(
    events.filter((event) => event.type === "run.event").at(-1).event.type,
    "run.completed",
  );
});

test("AgentWorkspace records summaries and serializes session replacement", async () => {
  const store = new InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const model = {
    async *stream(request) {
      const input = request.messages.at(-1)?.content[0]?.text ?? "empty";
      yield { type: "response.completed", message: assistant(`reply: ${input}`) };
    },
  };
  const openApplication = ({ sessionId, resume }) => AgentApplication.open({
    model,
    store,
    permissionPolicy: () => "allow",
    metadata: { workspace: "/work" },
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(resume ? { resume: true } : {}),
  });
  const workspace = await AgentWorkspace.open({
    workspace: "/work",
    store,
    catalog,
    openApplication,
  });

  const firstId = workspace.sessionId;
  await (await workspace.submit({ input: "first question" })).result;
  const secondId = await workspace.newSession();
  assert.notEqual(secondId, firstId);
  await workspace.resumeSession(firstId);
  assert.equal(workspace.sessionId, firstId);

  const summaries = await workspace.listSessions();
  assert.equal(summaries.length, 2);
  assert.equal(
    summaries.find((summary) => summary.id === firstId)?.title,
    "first question",
  );

  await workspace.transitionApplication(({ sessionId }) =>
    openApplication({ sessionId, resume: true })
  );
  assert.equal(workspace.sessionId, firstId);
  await workspace.close();
});

test("AgentApplication persists presentation metadata before approval", async () => {
  let modelCall = 0;
  const model = {
    async *stream() {
      modelCall += 1;
      yield modelCall === 1
        ? {
            type: "response.completed",
            message: {
              ...assistant(""),
              toolCalls: [{ id: "call-1", name: "change", input: { value: 1 } }],
            },
          }
        : { type: "response.completed", message: assistant("done") };
    },
  };
  const application = await AgentApplication.open({
    model,
    store: new InMemorySessionStore(),
    tools: [{
      name: "change",
      description: "Change a value",
      inputSchema: { type: "object" },
      parse: (input) => input,
      execute: async () => ({ changed: true }),
    }],
    permissionPolicy: () => ({ decision: "ask", grantKey: "change" }),
    createToolPresentation: () => ({
      kind: "example.change",
      version: 1,
      data: { preview: "1 -> 2" },
    }),
  });
  const seen = [];
  const relay = (async () => {
    for await (const event of application.events) {
      seen.push(event);
      if (
        event.type === "permission.event" &&
        event.event.type === "approval.requested"
      ) {
        await application.resolveApproval(event.event.request.id, "allow");
      }
    }
  })();

  await (await application.submit({ input: "change it" })).result;
  const history = await application.history();
  const presentationIndex = history.findIndex((event) =>
    event.type === "tool.presentation"
  );
  const approvalIndex = history.findIndex((event) =>
    event.type === "approval.requested"
  );
  assert.ok(presentationIndex >= 0);
  assert.ok(presentationIndex < approvalIndex);
  assert.equal(
    seen.find((event) => event.type === "tool.presentation")
      ?.presentation.kind,
    "example.change",
  );

  await application.close();
  await relay;
});

test("AsyncStateSerializer preserves FIFO order after a rejected operation", async () => {
  const serializer = new AsyncStateSerializer();
  const order = [];
  const first = serializer.run(async () => {
    order.push("first");
    throw new Error("failed");
  });
  const second = serializer.run(() => {
    order.push("second");
    return 2;
  });

  await assert.rejects(first, /failed/);
  assert.equal(await second, 2);
  assert.deepEqual(order, ["first", "second"]);
  await serializer.close();
});
