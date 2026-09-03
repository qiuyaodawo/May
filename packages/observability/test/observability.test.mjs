import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryContext, May } from "@may/core";
import {
  BasicTracer,
  BatchSpanProcessor,
  InMemorySpanProcessor,
  JsonlFileSpanExporter,
} from "../dist/index.js";

test("records a content-free Core trace with explicit parent relationships", async () => {
  const processor = new InMemorySpanProcessor();
  const tracer = new BasicTracer({
    processor,
    resourceAttributes: { "service.name": "trace-test" },
  });
  let modelCall = 0;
  const modelTraceContexts = [];
  let toolTraceContext;
  const runtime = new May({
    tracer,
    traceAttributes: { "may.agent.name": "example" },
    context: new InMemoryContext(),
    tools: [{
      name: "echo",
      description: "Echo a value",
      inputSchema: { type: "object" },
      async execute(_input, context) {
        toolTraceContext = context.traceContext;
        return { privateOutput: "do-not-capture" };
      },
    }],
    model: {
      async *stream(_request, options) {
        modelCall += 1;
        modelTraceContexts.push(options.traceContext);
        if (modelCall === 1) {
          yield {
            type: "retrying",
            attempt: 2,
            maxAttempts: 3,
            delayMs: 10,
            error: { name: "RateLimitError", code: "RATE_LIMIT" },
          };
          yield {
            type: "response.completed",
            message: {
              role: "assistant",
              content: [],
              toolCalls: [{
                id: "call_echo",
                name: "echo",
                input: { privateInput: "do-not-capture" },
              }],
            },
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          };
          return;
        }
        yield {
          type: "response.completed",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "private answer" }],
          },
          usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
        };
      },
    },
  });

  const run = runtime.run({ input: "private prompt" });
  await run.result;

  const spans = processor.getFinishedSpans();
  const root = one(spans, "may.run");
  const modelSpans = spans.filter((span) => span.name === "may.model.call");
  const batch = one(spans, "may.tools.batch");
  const tool = one(spans, "may.tool.call");

  assert.equal(run.traceContext?.spanId, root.context.spanId);
  assert.equal(modelSpans.length, 2);
  assert.ok(modelSpans.every((span) => span.parentSpanId === root.context.spanId));
  assert.equal(batch.parentSpanId, root.context.spanId);
  assert.equal(tool.parentSpanId, batch.context.spanId);
  assert.deepEqual(modelTraceContexts, modelSpans.map((span) => span.context));
  assert.deepEqual(toolTraceContext, tool.context);
  assert.equal(root.attributes["service.name"], "trace-test");
  assert.equal(root.attributes["may.agent.name"], "example");
  assert.equal(root.attributes["may.run.input_tokens"], 5);
  assert.equal(root.attributes["may.run.total_tokens"], 7);
  assert.equal(modelSpans[0].events[0].name, "may.model.retry");
  assert.equal(spans.every((span) => span.durationMs >= 0), true);

  const serialized = JSON.stringify(spans);
  assert.doesNotMatch(serialized, /private prompt|privateInput|privateOutput|private answer/);
});

test("tracing and bounded export failures remain off the Agent failure path", async () => {
  const runtime = new May({
    tracer: {
      startSpan() {
        throw new Error("telemetry unavailable");
      },
    },
    context: new InMemoryContext(),
    model: {
      async *stream() {
        yield {
          type: "response.completed",
          message: { role: "assistant", content: [] },
        };
      },
    },
  });
  assert.equal((await runtime.run({ input: "still runs" }).result).steps, 1);

  let releaseFirst;
  const firstExport = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const exported = [];
  let calls = 0;
  const processor = new BatchSpanProcessor({
    async export(spans) {
      calls += 1;
      if (calls === 1) await firstExport;
      exported.push(...spans);
    },
  }, {
    maxQueueSize: 2,
    maxExportBatchSize: 1,
    scheduledDelayMs: 60_000,
  });
  const tracer = new BasicTracer({ processor });

  for (let index = 0; index < 4; index++) {
    tracer.startSpan(`span-${index}`).end();
  }
  assert.equal(processor.droppedSpans, 1);
  releaseFirst();
  await processor.shutdown();
  assert.equal(exported.length, 3);
});

test("rotates JSONL spans by local date and retains sixty calendar days", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "may-traces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "traces-2026-07-05.jsonl"), "expired\n");
  await writeFile(join(directory, "traces-2026-07-06.jsonl"), "retained\n");
  await writeFile(join(directory, "other-2026-07-05.jsonl"), "unrelated\n");

  const exporter = new JsonlFileSpanExporter({
    path: join(directory, "traces.jsonl"),
    rotation: "daily",
    retentionDays: 60,
    clock: () => new Date(2026, 8, 3, 12).getTime(),
  });
  await exporter.export([
    finishedSpan("previous", new Date(2026, 8, 2, 23, 59).getTime()),
    finishedSpan("today", new Date(2026, 8, 3, 0, 1).getTime()),
  ]);
  await exporter.shutdown();

  const files = (await readdir(directory)).sort();
  assert.deepEqual(files, [
    "other-2026-07-05.jsonl",
    "traces-2026-07-06.jsonl",
    "traces-2026-09-02.jsonl",
    "traces-2026-09-03.jsonl",
  ]);
  assert.match(
    await readFile(join(directory, "traces-2026-09-02.jsonl"), "utf8"),
    /"name":"previous"/u,
  );
  assert.match(
    await readFile(join(directory, "traces-2026-09-03.jsonl"), "utf8"),
    /"name":"today"/u,
  );
});

function one(spans, name) {
  const matches = spans.filter((span) => span.name === name);
  assert.equal(matches.length, 1, `expected exactly one ${name} span`);
  return matches[0];
}

function finishedSpan(name, endTime) {
  return {
    name,
    context: { traceId: `trace_${name}`, spanId: `span_${name}`, sampled: true },
    startTime: endTime - 1,
    endTime,
    durationMs: 1,
    status: "ok",
    attributes: {},
    events: [],
  };
}
