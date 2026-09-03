# `@may/observability`

Fail-open tracing processors and exporters for May agents.

Core owns the small `Tracer`/`TraceSpan` port. This package depends on Core to
implement that port without making telemetry a required Core dependency.

```ts
import { defineAgent } from "@may/application";
import {
  BasicTracer,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ratioSampler,
} from "@may/observability";

const processor = new BatchSpanProcessor(
  new ConsoleSpanExporter(),
  { maxQueueSize: 2_048, maxExportBatchSize: 256 },
);
const tracer = new BasicTracer({
  processor,
  sampler: ratioSampler(0.1),
  resourceAttributes: { "service.name": "example-agent" },
});

const agent = defineAgent({
  model,
  tools,
  permissionPolicy,
  tracer,
  traceAttributes: { "may.agent.name": "example" },
});

const application = await agent.open({ store });
// ...use and close every application that shares the tracer...
await application.close();
await processor.shutdown();
```

`BasicTracer` creates immutable completed spans. Child spans inherit the
parent trace id and sampling decision. Available processors and exporters are:

- `InMemorySpanProcessor` for deterministic tests and local inspection;
- `SimpleSpanProcessor` for serialized export outside the Agent call stack;
- `BatchSpanProcessor` for bounded, non-blocking batching, with
  `droppedSpans` exposing buffer pressure;
- `InMemorySpanExporter`; and
- `ConsoleSpanExporter`, which writes one JSON span per line; and
- `JsonlFileSpanExporter`, which serializes appends to a local JSONL file and
  creates its parent directory on first export.

`alwaysOnSampler`, `alwaysOffSampler`, and deterministic `ratioSampler()` are
provided. A custom `SpanProcessor` can derive metrics or adapt completed spans
to an external tracing SDK without changing Core.

May's built-in instrumentation records identifiers, counts, timings, statuses,
usage, tool names, permission decisions, and content-free error type/code
metadata. It does not record prompts, messages, tool input/output, reasoning,
or credentials. Callers control custom trace attributes and must keep them free
of sensitive or unbounded values.

Telemetry is not durable Session history or an audit log. Core protects calls
to injected tracers, and the provided processors contain exporter failures, so
observability failure does not fail a Run. Processors are caller-owned shared
resources: an `AgentApplication` never shuts them down automatically.
