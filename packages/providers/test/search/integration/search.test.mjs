import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadMayConfig, resolveModelProfile } from "@sortedyuan/may/config";
import { AnthropicModel, OpenAIResponsesModel, OpenAIChatCompletionsModel, GeminiModel } from "../../../dist/index.js";

const cases = [
  ["anthropic-messages", AnthropicModel, { version: "web_search_20260209", allowedCallers: ["direct"] }, "direct"],
  ["anthropic-messages", AnthropicModel, { version: "web_search_20260209" }, "dynamic"],
  [
    "anthropic-messages",
    AnthropicModel,
    { version: "web_search_20260209", allowedCallers: ["direct"] },
    "anthropic-mixed",
  ],
  ["openai-responses", OpenAIResponsesModel, {}, "responses"],
  ["openai-chat-completions", OpenAIChatCompletionsModel, {}, "chat"],
  ["google-gemini", GeminiModel, {}, "gemini"],
  ["google-gemini", GeminiModel, {}, "gemini-functions"],
];

for (const [adapter, Model, webSearch, label] of cases) {
  test(`live web search and history: ${label}`, { timeout: 180000 }, async (t) => {
    const config = await loadMayConfig();
    const selected = Object.keys(config.models)
      .map((name) => resolveModelProfile(config, name))
      .find((profile) => profile.adapter === adapter && (label !== "chat" || profile.model === "gpt-5-search-api"));
    if (!selected?.providerConfig.apiKey)
      return t.skip(`No configured credentials/model for ${adapter}${label === "chat" ? " gpt-5-search-api" : ""}`);
    const directory = resolve(".test-output", "server-search", label);
    await mkdir(directory, { recursive: true });
    let sequence = 0;
    const model = new Model({
      ...selected.providerConfig,
      ...selected.options,
      model: selected.model,
      webSearch,
      fetch: async (url, init) => {
        const index = sequence++;
        await writeFile(resolve(directory, `${index}.request.json`), init.body);
        const response = await fetch(url, init);
        const bytes = new Uint8Array(await response.arrayBuffer());
        await writeFile(resolve(directory, `${index}.response.txt`), bytes);
        await writeFile(
          resolve(directory, `${index}.metadata.json`),
          JSON.stringify({
            status: response.status,
            contentType: response.headers.get("content-type"),
            adapter,
            model: selected.model,
          }),
        );
        return new Response(bytes, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    const tools =
      label === "gemini-functions" || label === "anthropic-mixed"
        ? [
            {
              name: "add",
              description: "Add two numbers",
              inputSchema: {
                type: "object",
                properties: { a: { type: "number" }, b: { type: "number" } },
                required: ["a", "b"],
              },
            },
          ]
        : [];
    const prompt =
      "Search the web for the latest official Node.js release. Cite the official source URL. Answer in Chinese and include an emoji." +
      (label === "anthropic-mixed"
        ? " Also call the add function to calculate 124 + 219, and include its result."
        : "");
    const messages = [{ role: "user", content: [{ type: "text", text: prompt }] }];
    let completed;
    for (let turn = 0; turn < 9; turn += 1) {
      const events = [];
      for await (const event of model.stream({ messages, tools }, { signal: AbortSignal.timeout(150000) }))
        events.push(event);
      completed = events.at(-1);
      assert.equal(completed.type, "response.completed");
      await writeFile(resolve(directory, `${turn}.events.json`), JSON.stringify(events, null, 2));
      messages.push(completed.message);
      if (completed.message.toolCalls?.length) {
        for (const call of completed.message.toolCalls) {
          assert.equal(call.name, "add");
          assert.equal(typeof call.input.a, "number");
          assert.equal(typeof call.input.b, "number");
          assert.equal(typeof call.rawInput, "string");
          assert.deepEqual(JSON.parse(call.rawInput), call.input);
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: [{ type: "text", text: String(call.input.a + call.input.b) }],
          });
        }
        continue;
      }
      if (!completed.message.continuation) break;
    }
    assert.ok(completed);
    assert.equal(completed.message.continuation, undefined);
    messages.push({
      role: "user",
      content: [{ type: "text", text: "Repeat the release version and its source in one sentence." }],
    });
    let historyResult;
    for await (const event of model.stream({ messages, tools }, { signal: AbortSignal.timeout(150000) }))
      if (event.type === "response.completed") historyResult = event;
    assert.ok(historyResult, "History continuation completed");
    await writeFile(resolve(directory, "history.events.json"), JSON.stringify(historyResult, null, 2));
    if (label !== "chat")
      assert.ok(
        messages.some((message) =>
          message.serverToolCalls?.some((call) => call.kind === "web_search" && call.status === "completed"),
        ),
        "Expected completed web search",
      );
    assert.ok(
      messages.some((message) => message.content.some((part) => part.citations?.length)),
      "Expected URL citations",
    );
    if (label === "anthropic-mixed")
      assert.ok(
        messages.some((message) => message.toolCalls?.length),
        "Expected a client function call",
      );
  });
}
