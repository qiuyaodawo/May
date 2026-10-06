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

- `InMemorySpanProcessor` for local inspection with a configurable retention limit;
- `SimpleSpanProcessor` for bounded, serialized single-span export;
- `BatchSpanProcessor` for bounded, non-blocking batching, with
  `droppedSpans` exposing buffer pressure;
- `InMemorySpanExporter`; and
- `ConsoleSpanExporter`, which writes one JSON span per line; and
- `JsonlFileSpanExporter`, which serializes appends to local JSONL files,
  optionally rotates by local calendar date, and enforces a day-based
  retention window (60 days by default when rotation is enabled).

`alwaysOnSampler`, `alwaysOffSampler`, and deterministic `ratioSampler()` are
provided. `BasicTracer` accepts a `MetricRecorder` and `SpanObserver` that receive
every operation independently of trace sampling.

```ts
import { BoundedMetrics, DiagnosticsStore } from "@may/observability";

const metrics = new BoundedMetrics();
const diagnostics = new DiagnosticsStore();
const tracer = new BasicTracer({ processor, metrics, observer: diagnostics });
const page = diagnostics.getDiagnostics({ sessionId: "session-123", limit: 100 });
const counters = metrics.getMetrics();
const delivery = processor.getDiagnostics();
```

Metrics include operation/status counts, active operations, duration and first
output histograms, retries and measured retry waits, usage, cost, and missing data. Costs
retain currency, estimated/provider kind, and completeness labels. Label allowlists and
series limits prevent identifiers from growing metric storage without bounds.
Local diagnostics retain completed and unfinished spans, including unsampled
operations, and support paged filtering by trace/task/Session/Run. External task
assessments associate evaluator/configuration versions with evidence references.
Assessments accept Session/Run/coordination/trace scope; missing identity is inferred
at recording only when retained task spans identify a unique value. Scoped queries
match saved scope, which remains valid after span eviction.

`may.model.call` contains logical latency including retries; child
`may.model.attempt` spans have independent outcomes and timing. First content and
first displayable text are distinct measurements; missing output times stay
absent. Wrapper adapters preserve `reportsAttempts` and `attemptObserver`.
Calls include safe configuration, capability/price versions, detailed usage,
and the same `UsageCost` result used by budgets.
Completed responses that fail validation retain known usage and pricing receipts
in failed attempts, calls, and Runs. Accounting occurs once before Context
persistence and completion Hooks; final-event Hook failures preserve the received
receipt. Usage completeness uses the same `resolveUsageTotals` calculation as
budgets. Token/cost metrics are recorded only at logical-call completion.

`OpenTelemetryTracer` and `OpenTelemetryMetricRecorder` connect existing official
OpenTelemetry API instances. `createOtlpTelemetry()` owns official SDK providers
and HTTP/JSON trace/metric exporters with explicit endpoints, bounded queues,
concurrency, timeout, series, and lifecycle waits. Providers stay local to the
composition. `getDiagnostics()` reports export and lifecycle failures;
`forceFlush()` and idempotent `shutdown()` manage delivery and resources.

Attributes default to 64 entries, 256 characters per string, 16 array elements,
and 64 retained span events. Finite values are required; content/credential keys
are rejected. Memory processors/exporters default to 2,048 retained spans.
Batch and simple processors expose queue/drop/failure/timeout diagnostics, with
five-second export and shutdown timeouts. Ordinary failed batches are released;
export timeout closes the processor and discards queued records. A later
`shutdown()` releases exporter resources.

See the [English guide](../../docs/en/guides/observability.md) and
[简体中文指南](../../docs/zh-CN/guides/observability.md) for complete examples,
correlation, acceptance, limits, and lifecycle behavior.

May's built-in instrumentation records identifiers, counts, timings, statuses,
usage, tool names, permission decisions, and content-free error type/code
metadata. It does not record prompts, messages, tool input/output, reasoning,
or credentials. Callers control custom trace attributes and must keep them free
of sensitive or unbounded values.

Telemetry is not durable Session history or an audit log. Core protects calls
to injected tracers, and the provided processors contain exporter failures, so
observability failure does not fail a Run. Processors are caller-owned shared
resources: an `AgentApplication` never shuts them down automatically.
