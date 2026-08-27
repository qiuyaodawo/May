import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunCancelledError } from "@may/core";
import { FileSessionStore } from "@may/session/file-store";
import {
  InMemorySessionCatalog,
  MaybeCodeWorkspace,
} from "../dist/index.js";

test("runs coding tools and reuses an approved session grant", async (t) => {
  const workspace = await temporaryDirectory(t);
  const events = [];
  let modelCall = 0;
  const model = {
    async *stream() {
      modelCall += 1;
      if (modelCall === 1 || modelCall === 3) {
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [],
            toolCalls: [{
              id: `write_${modelCall}`,
              name: "write",
              input: {
                path: "result.txt",
                content: modelCall === 1 ? "first" : "second",
              },
            }],
          },
        };
        return;
      }
      yield {
        type: "response.completed",
        message: assistantMessage(modelCall === 2 ? "created" : "updated"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new FileSessionStore(join(workspace, ".sessions")),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });
  const eventReader = collectEvents(app, events, "allow-session");

  assert.equal(
    (await (await app.submit({ input: "create result" })).result).message
      .content[0].text,
    "created",
  );
  assert.equal(
    (await (await app.submit({ input: "update result" })).result).message
      .content[0].text,
    "updated",
  );
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "second");

  const history = await app.history();
  assert.equal(
    history.filter((event) => event.type === "approval.requested").length,
    1,
  );
  assert.ok(
    history.findIndex((event) => event.type === "approval.resolved") <
      history.findIndex((event) => event.type === "tool.completed"),
  );

  await app.close();
  await eventReader;
  assert.equal(
    events.filter((event) =>
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ).length,
    1,
  );
});

test("executes read, write, edit, and bash through the application", async (t) => {
  const workspace = await temporaryDirectory(t);
  await writeFile(join(workspace, "source.txt"), "source", "utf8");
  const calls = [
    { id: "read", name: "read", input: { path: "source.txt" } },
    {
      id: "write",
      name: "write",
      input: { path: "target.txt", content: "old" },
    },
    {
      id: "edit",
      name: "edit",
      input: { path: "target.txt", oldText: "old", newText: "new" },
    },
    {
      id: "bash",
      name: "bash",
      input: { command: "node -e \"process.stdout.write('verified')\"" },
    },
  ];
  let modelCall = 0;
  const model = {
    async *stream() {
      const call = calls[modelCall++];
      yield {
        type: "response.completed",
        message: call === undefined
          ? assistantMessage("done")
          : { role: "assistant", content: [], toolCalls: [call] },
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace,
    model,
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });
  const events = [];
  const eventReader = collectEvents(app, events, "allow");

  await (await app.submit({ input: "use every tool" })).result;
  assert.equal(await readFile(join(workspace, "target.txt"), "utf8"), "new");
  await app.close();
  await eventReader;

  const completed = events
    .filter((event) =>
      event.type === "run.event" && event.event.type === "tool.completed"
    )
    .map((event) => event.event);
  assert.deepEqual(completed.map((event) => event.call.name), [
    "read",
    "write",
    "edit",
    "bash",
  ]);
  assert.equal(completed[3].output.stdout, "verified");
});

test("auto-resumes, lists, creates, and switches workspace sessions", async () => {
  const store = new (await import("@may/session")).InMemorySessionStore();
  const catalog = new InMemorySessionCatalog();
  const requests = [];
  const model = {
    async *stream(request) {
      requests.push(request);
      yield {
        type: "response.completed",
        message: assistantMessage(`answer ${requests.length}`),
      };
    },
  };
  const options = {
    workspace: process.cwd(),
    model,
    store,
    catalog,
  };

  const first = await MaybeCodeWorkspace.open({ ...options, autoResume: false });
  const firstId = first.sessionId;
  await (await first.submit({ input: "first" })).result;
  await first.close();

  const resumed = await MaybeCodeWorkspace.open(options);
  assert.equal(resumed.sessionId, firstId);
  await (await resumed.submit({ input: "second" })).result;
  assert.deepEqual(requests[1].messages.map((message) => message.role), [
    "system",
    "user",
    "assistant",
    "user",
  ]);

  const secondId = await resumed.newSession();
  assert.notEqual(secondId, firstId);
  assert.equal((await resumed.listSessions()).length, 2);
  await resumed.resumeSession(firstId);
  assert.equal(resumed.sessionId, firstId);
  await resumed.close();
});

test("cancels an active model call", async () => {
  let started;
  const modelStarted = new Promise((resolve) => {
    started = resolve;
  });
  const model = {
    async *stream(_request, { signal }) {
      started();
      await new Promise((resolve) => {
        signal.addEventListener("abort", resolve, { once: true });
      });
      yield {
        type: "response.completed",
        message: assistantMessage("unreachable"),
      };
    },
  };
  const app = await MaybeCodeWorkspace.open({
    workspace: process.cwd(),
    model,
    store: new (await import("@may/session")).InMemorySessionStore(),
    catalog: new InMemorySessionCatalog(),
    autoResume: false,
  });

  const run = await app.submit({ input: "wait" });
  await modelStarted;
  assert.equal(app.cancel("stop"), true);
  await assert.rejects(run.result, RunCancelledError);
  await app.close();
});

function assistantMessage(text) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

async function collectEvents(app, target, approvalDecision) {
  for await (const event of app.events) {
    target.push(event);
    if (
      event.type === "permission.event" &&
      event.event.type === "approval.requested"
    ) {
      await app.resolveApproval(event.event.request.id, approvalDecision);
    }
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "maybe-code-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
