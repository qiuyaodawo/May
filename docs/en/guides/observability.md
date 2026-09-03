# Observability and tracing

**English** | [简体中文](../../zh-CN/guides/observability.md)

May tracing explains where an Agent Run spent time and how Core, Context,
models, tools, permissions, Sessions, and applications relate. It is optional
operational telemetry, not durable conversation history.

## Events, history, and traces

- `MayEvent` and `AgentApplicationEvent` drive live presentation and lifecycle
  observation.
- `SessionEvent` is an append-oriented durable fact used for resume and
  history.
- A trace is sampled operational data. It may be buffered or dropped and must
  never be the source of truth for Session or permission state.

One `may.run` span identifies a Run. Model, Context, tool-batch, and tool-call
spans are its children. Permission spans are children of the relevant tool
call. A Session adds `may.session.id` to the Run; separate Runs in the same
Session remain separate traces.

## Configure a tracer

Core exports only the `Tracer`, `TraceSpan`, `TraceContext`, attribute, and
fail-open helper contracts. `@may/observability` provides the standard
implementation:

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
  {
    maxQueueSize: 2_048,
    maxExportBatchSize: 256,
    scheduledDelayMs: 2_000,
  },
);

const tracer = new BasicTracer({
  processor,
  sampler: ratioSampler(0.1),
  resourceAttributes: { "service.name": "example-agent" },
});

const definition = defineAgent({
  model,
  tools,
  permissionPolicy,
  tracer,
  traceAttributes: { "may.agent.name": "example" },
});

const application = await definition.open({ store });
const run = await application.submit({ input: "Inspect the project" });
console.log(run.traceContext?.traceId);
await run.result;
await application.close();

// Do this only after every application sharing this processor has closed.
await processor.shutdown();
```

`AgentDefinition` captures the tracer as a caller-owned collaborator and
shallow-snapshots `traceAttributes`. Each Run may add more content-free
attributes or an explicit parent `traceContext`. `ModelStreamOptions`,
`ToolExecutionContext`, `RunHandle`, and `AgentRun` expose propagated trace
context for provider, remote-tool, and parent-operation integration.

## Built-in spans

| Span | Purpose |
| --- | --- |
| `may.application.open` | Create/resume and validate one application Session |
| `may.run` | Root Core Run, outcome, counts, and aggregate token usage |
| `may.context.snapshot` | Prepare the model-visible Context snapshot |
| `may.context.append` | Append input, assistant, or tool-result messages |
| `may.model.call` | One model stream, usage, tool-call count, and retry events |
| `may.tools.batch` | Schedule one model response's tool calls |
| `may.tool.call` | Parse, authorize, and execute one Tool |
| `may.permission.check` | Evaluate the permission policy |
| `may.permission.approval_wait` | Wait for an explicit approval decision |
| `may.context.compact` | Explicit application-requested compaction |

For example, a slow tool operation may appear as:

```text
may.tool.call                    9.72s
|- may.permission.check          0.01s
`- may.permission.approval_wait  8.90s
```

That separates user wait time from the remaining tool execution time. A model
span's `may.model.retry` event similarly distinguishes provider retry delay
from Context preparation or tool latency.

## Processors, exporters, and sampling

- `InMemorySpanProcessor` retains completed spans for tests and inspection.
- `SimpleSpanProcessor` serializes exporter calls away from the Agent stack.
- `BatchSpanProcessor` uses a bounded queue and exposes `droppedSpans`; it
  never applies exporter backpressure to a Run.
- `InMemorySpanExporter` and `ConsoleSpanExporter` are included.
- `JsonlFileSpanExporter` serializes local JSONL appends and can rotate by
  local calendar date with a bounded retention window.
- `alwaysOnSampler`, `alwaysOffSampler`, and `ratioSampler()` select root
  traces; child spans inherit their parent's decision.

Processors own asynchronous export and lifecycle. Call `forceFlush()` when a
checkpoint needs all queued spans and `shutdown()` once at the actual owner.
Closing one application must not shut down a processor shared by another.

External tracing systems should be integrated through a custom
`SpanExporter` or `SpanProcessor`. Keep provider SDK types outside Core.

## Enable tracing in MaybeCode

MaybeCode owns a ready-to-use local file composition. Add this to May's config:

```json
{
  "apps": {
    "maybecode": {
      "observability": {
        "enabled": true,
        "exporter": "file",
        "file": "traces/traces.jsonl",
        "samplingRatio": 1,
        "retentionDays": 60
      }
    }
  }
}
```

When enabled, every application opened or rebuilt by the workspace shares one
tracer and batch processor. MaybeCode flushes it only after the whole workspace
closes. `file` is a base path; the local date is inserted before its extension.
A relative path is based on the MaybeCode data directory, making the default
files `~/.may/maybecode/traces/traces-YYYY-MM-DD.jsonl`.

MaybeCode retains 60 local calendar days, including today, unless
`retentionDays` overrides it. On the first export of each day it removes only
older files matching the configured base name and date pattern. Unrelated
files are not touched.

With no `observability` entry, or with `false`/`enabled: false`, MaybeCode's
behavior remains unchanged and no trace file is created. See the
[configuration reference](../reference/configuration.md) for batch settings.

## Privacy and failure behavior

Built-in instrumentation records names, ids, counts, timings, statuses, token
usage, permission decisions, and content-free error type/code metadata. It does
not capture prompts, messages, reasoning, tool inputs/outputs, or credentials.
Custom `traceAttributes` are caller data: do not place secrets, large payloads,
or unbounded user-controlled values in them.

Core wraps injected tracer and span calls. Provided processors catch exporter
failures and optionally report them through `onError`. A broken telemetry
backend therefore cannot fail or cancel Agent work. This fail-open behavior is
why tracing cannot replace a durable audit or Permission record.

The current package provides tracing foundations rather than a metrics
backend, dashboard, or vendor-specific exporter. Metrics can be derived by a
custom processor from completed spans without changing the runtime contract.
