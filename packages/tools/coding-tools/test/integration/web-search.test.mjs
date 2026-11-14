import assert from "node:assert/strict";
import test from "node:test";
import { loadMayConfig, resolveModelProfile } from "@sortedyuan/may/config";
import { createDeepSeekSearchBackend, createWebSearchTool, WebSearchToolError } from "../../dist/index.js";

async function execute(tool, input) {
  return tool.execute(await tool.parse(input), { signal: new AbortController().signal });
}

test("DeepSeek Search maps real results, summary limits, usage and HTTP errors", { timeout: 120_000 }, async (t) => {
  const loaded = await loadMayConfig();
  const entry = Object.entries(loaded.models).find(
    ([, profile]) => (profile.adapter ?? loaded.providers[profile.provider]?.adapter) === "deepseek-chat",
  );
  if (entry === undefined) return t.skip("No DeepSeek model configured");
  const resolved = resolveModelProfile(loaded, entry[0]);
  const { apiKey, baseURL } = resolved.providerConfig;
  if (typeof apiKey !== "string" || apiKey.trim() === "") return t.skip("No DeepSeek credentials configured");
  let raw;
  const backend = createDeepSeekSearchBackend({
    apiKey,
    baseURL,
    async fetch(url, options) {
      const response = await fetch(url, options);
      assert.equal(new URL(url).pathname, "/v1/tools/search");
      assert.deepEqual(JSON.parse(options.body), { query: "DeepSeek site:deepseek.com", count: 2 });
      assert.equal(response.status, 200);
      raw = await response.clone().json();
      return response;
    },
  });
  const input = { query: "DeepSeek site:deepseek.com", count: 2 };
  const output = await execute(createWebSearchTool({ backend, maxSummaryChars: 20 }), input);
  assert.ok(raw.results.length > 0);
  assert.ok(output.items.length > 0 && output.items.length <= 2);
  for (const item of output.items) {
    assert.equal(typeof item.title, "string");
    assert.ok(URL.canParse(item.url));
    assert.ok([...item.summary].length <= 20);
  }
  assert.deepEqual(output.usage.items, [
    { id: "web-search:deepseek", quantity: 1, unit: "requests", includedIn: "none" },
  ]);
  assert.deepEqual(
    output.items,
    raw.results.slice(0, 2).map((item) => ({
      title: item.title,
      url: item.url,
      summary: [...item.summary].slice(0, 20).join(""),
      ...(item.site_name == null ? {} : { siteName: item.site_name }),
      ...(item.date == null ? {} : { published: item.date }),
    })),
  );
  const versioned = createDeepSeekSearchBackend({
    apiKey,
    baseURL: new URL("/v1", baseURL ?? "https://api.deepseek.com").href,
  });
  assert.ok((await versioned.search(input, AbortSignal.timeout(30_000))).items.length > 0);
  await assert.rejects(
    createDeepSeekSearchBackend({ apiKey: "invalid-search-test-key", baseURL }).search(
      input,
      AbortSignal.timeout(30_000),
    ),
    (error) => error instanceof WebSearchToolError && error.status === 401 && typeof error.code === "string",
  );
});
