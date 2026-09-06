import assert from "node:assert/strict";
import test from "node:test";
import { May, InMemoryContext } from "@may/core";
import { openMcpClientPool, mcpResourceToUserMessage, mcpPromptToUserMessage, mcpToolResultContent, previewMcpMessage } from "../dist/index.js";
import { startCatalogFixture } from "./fixtures/catalog-server.mjs";

test("resource, prompt and completion operations preserve ownership, limits, cache invalidation and both subscription eras", { timeout: 15_000 }, async (t) => {
  const fixture = await startCatalogFixture(t);
  const pool = await openMcpClientPool({ servers: ["modern", "legacy"].map((id) => ({ id, transport: "streamable-http", url: `${fixture.url}/${id}`, requestTimeoutMs: 1000 })) });
  t.after(() => pool.close());
  const count = (method, server) => fixture.requests.filter((r) => r.message?.method === method && (server === undefined || r.path === `/${server}`)).length;
  for (const server of ["modern", "legacy"]) {
    const read = await pool.readResource(server, "test:///first");
    assert.equal(read.fromCache, false);
    assert.equal((await pool.readResource(server, "test:///first")).fromCache, true);
    assert.equal(count("resources/read", server), 1);
    const watchAbort = new AbortController();
    const first = await pool.subscribeResource(server, "test:///first", { signal: watchAbort.signal });
    const second = await pool.subscribeResource(server, "test:///first");
    const events = first.events[Symbol.asyncIterator]();
    fixture.state.version++;
    fixture.update("test:///first");
    assert.equal((await events.next()).value.uri, "test:///first");
    assert.equal((await pool.readResource(server, "test:///first")).fromCache, false);
    const secondEvents = second.events[Symbol.asyncIterator]();
    assert.equal((await secondEvents.next()).value.type, "updated");
    watchAbort.abort();
    await first.close();
    fixture.update("test:///first");
    assert.equal((await secondEvents.next()).value.type, "updated");
    assert.equal(await first.closed, "local");
    if (server === "legacy") assert.equal(count("resources/unsubscribe", server), 0);
    await second.close();
    if (server === "legacy") {
      assert.equal(count("resources/subscribe", server), 1);
      assert.equal(count("resources/unsubscribe", server), 1);
    }
    const image = await pool.readResourceTemplate(server, "test:///{name}", { name: "image" });
    const message = mcpResourceToUserMessage(image);
    assert.equal(message.role, "user");
    assert.equal(message.content.at(-1).type, "image");
    assert.match(previewMcpMessage(message), /binary attachment/);
    assert.doesNotMatch(previewMcpMessage(message), /aGVsbG8=/);
    const prompt = await pool.getPrompt(server, "review", { file: "a  b.txt" });
    const promptMessage = mcpPromptToUserMessage(prompt);
    assert.equal(promptMessage.role, "user");
    assert.ok(promptMessage.content.some((part) => part.type === "text" && part.text === "Review a  b.txt"));
    assert.ok(promptMessage.content.some((part) => part.type === "json" && part.value.automaticFetch === false));
    assert.throws(() => pool.getPrompt(server, "review", {}), /missing prompt arguments/);
    assert.deepEqual(await pool.complete(server, { ref: { type: "ref/prompt", name: "review" }, argument: { name: "file", value: "ma" } }), { values: ["ma-completed"], total: 7, hasMore: true });
    assert.equal((await pool.complete(server, { ref: { type: "ref/resource", uri: "test:///{name}" }, argument: { name: "name", value: "a" } })).values[0], "a-completed");
    await assert.rejects(pool.readResource(server, "test:///invalid"), (e) => e.code === "MCP_CONTENT_ERROR");
    const cancel = new AbortController();
    const pending = assert.rejects(pool.readResource(server, "test:///hold", { signal: cancel.signal }));
    cancel.abort(); await pending;
  }
  await assert.rejects(pool.readResource("modern", "test:///large"), (e) => e.code === "MCP_CONTENT_ERROR");
  await assert.rejects(pool.readResource("modern", "test:///wirelarge"));
  const old = await pool.readResource("modern", "test:///first");
  await pool.reconnect("modern");
  assert.equal((await pool.readResource("modern", "test:///first")).fromCache, false);
  assert.ok(Object.isFrozen(old.result.contents[0]));
  const watch = await pool.subscribeResource("modern", "test:///first");
  await pool.close();
  assert.ok(["local", "remote", "connection-closed"].includes(await watch.closed));
});

test("MCP multimodal tool projection reaches model content while raw events retain structured output", async () => {
  const output = { content: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }], structuredContent: { count: 1 }, _meta: { hidden: "host-only" } };
  let resultContent;
  const runtime = new May({ context: new InMemoryContext(), tools: [{ name: "remote", description: "remote", inputSchema: {},
    async execute() { return output; }, resultContent: (result) => mcpToolResultContent("fixture", "remote", result),
  }], model: { async *stream(request, options) {
    if (options.step === 2) resultContent = request.messages.at(-1).content;
    yield { type: "response.completed", message: { role: "assistant", content: [],
      ...(options.step === 1 ? { toolCalls: [{ id: "a", name: "remote", input: {} }] } : {}),
    } };
  } } });
  const run = runtime.run({ input: "go" });
  const events = []; for await (const event of run.events) events.push(event);
  await run.result;
  assert.equal(resultContent[1].type, "image");
  assert.deepEqual(resultContent.at(-1), { type: "json", value: { count: 1 } });
  assert.doesNotMatch(JSON.stringify(resultContent), /host-only/);
  assert.equal(events.find((event) => event.type === "tool.completed").output, output);
});
