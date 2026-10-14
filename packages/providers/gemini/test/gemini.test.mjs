import assert from "node:assert/strict";
import test from "node:test";
import { convertGeminiUsage, GeminiModel, GeminiProtocolError, toGeminiRequestParts } from "../dist/index.js";

test("maps observed Gemini hello usage with reasoning and cached input", () => {
  const usage = convertGeminiUsage({ promptTokenCount: 6302, candidatesTokenCount: 9, totalTokenCount: 6529, cachedContentTokenCount: 4277, thoughtsTokenCount: 218 });
  assert.equal(usage.inputTokens, 6302);
  assert.equal(usage.outputTokens, 227);
  assert.equal(usage.cachedReadTokens, 4277);
  assert.equal(usage.reasoningTokens, 218);
  assert.equal(usage.totalTokens, 6529);
  assert.deepEqual(usage.tokenRelations, { cachedRead: "input", reasoning: "output" });
});

test("preserves absence of unreported counts and rejects invalid counts", () => {
  const usage = convertGeminiUsage({ promptTokenCount: 6302, candidatesTokenCount: 9, totalTokenCount: 6311, cachedContentTokenCount: 4277 });
  assert.equal(usage.reasoningTokens, undefined);
  assert.equal(usage.outputTokens, 9);
  assert.equal(convertGeminiUsage({}).inputTokens, undefined);
  assert.equal(convertGeminiUsage({}).completeness.status, "partial");
  assert.throws(() => convertGeminiUsage({ promptTokenCount: 2025, cachedContentTokenCount: 4277 }), GeminiProtocolError);
  for (const value of [-1, 1.5, NaN, Infinity, "42"]) {
    assert.throws(() => convertGeminiUsage({ thoughtsTokenCount: value }), GeminiProtocolError);
  }
});

test("converts system and user content and rejects unsupported resources", () => {
  assert.deepEqual(toGeminiRequestParts([
    { role: "system", content: [{ type: "text", text: "Instructions" }] },
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ]), {
    systemInstruction: { parts: [{ text: "Instructions" }] },
    contents: [{ role: "user", parts: [{ text: "hello" }] }],
  });
  assert.throws(() => toGeminiRequestParts([{ role: "user", content: [{ type: "resource", uri: "test:resource" }] }]), /Google Gemini/);
  assert.throws(() => toGeminiRequestParts([{ role: "tool", name: "add", toolCallId: "unmatched", content: [] }]), /Unmatched/);
});

test("validates configuration before sending requests", () => {
  const options = { apiKey: "configuration-validation", model: "gemini-3.8-flash" };
  assert.throws(() => new GeminiModel({ ...options, apiKey: "" }), /apiKey/);
  assert.throws(() => new GeminiModel({ ...options, maxOutputTokens: 0 }), /maxOutputTokens/);
  assert.throws(() => new GeminiModel({ ...options, thinkingBudget: -2 }), /thinkingBudget/);
  assert.throws(() => new GeminiModel({ ...options, thinkingBudget: 0, reasoningEffort: "high" }), /mutually exclusive/);
  assert.throws(() => new GeminiModel({ ...options, baseURL: "https://example.com/v1?key=secret" }), /baseURL/);
});
