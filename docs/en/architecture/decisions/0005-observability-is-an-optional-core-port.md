# ADR 0005: Observability implements an optional Core-owned tracing port

**English** | [简体中文](../../../zh-CN/architecture/decisions/0005-observability-is-an-optional-core-port.md)

- **Status:** Accepted
- **Date:** 2026-09-03

## Context

May needs causal timing and status data across Runs, model calls, tools,
permissions, Context work, applications, and future MCP calls. Existing live
events and durable Session events have different reliability and privacy
semantics; turning either stream into an implicit audit/telemetry backend would
mix those responsibilities.

Making Core depend on an exporter or external tracing SDK would make optional
telemetry mandatory, weaken the minimal runtime boundary, and risk a cycle
because May-specific processors need Core event and execution types.

## Decision

Core owns a small synchronous `Tracer`/`TraceSpan` port plus explicit
`TraceContext` propagation. Instrumented runtime calls are fail-open. They
record content-free identifiers, counts, status, usage, and error type/code by
default, not prompts, messages, reasoning, or tool input/output.

The optional `@may/observability` package depends on Core and implements the
port with sampling, immutable finished spans, in-memory and serialized/bounded
processors, and basic exporters. Asynchronous export belongs to processors and
must not add backpressure or exporter failures to Agent execution.

Tracer and processor lifetime remains caller-owned. `AgentDefinition` may
capture a tracer, but closing an application does not shut down a tracer shared
by other applications. A product flushes and shuts down processors at its real
ownership boundary.

Trace data is operational and may be sampled or dropped. Session and
permission events remain the durable source of truth. Vendor integrations use
custom processors/exporters so their SDK types do not enter Core APIs.

## Consequences

- Core has no runtime dependency on `@may/observability` or a vendor SDK.
- Direct Core, Session, Application, Provider, and remote-tool users can
  propagate the same trace context explicitly without process-global state.
- A broken tracer or exporter cannot fail a Run.
- Buffer pressure is visible through processor counters but does not block the
  Agent.
- Products must keep custom attributes content-free or apply their own privacy
  policy.
- Metrics, dashboards, and vendor-specific exporters remain adapters built on
  completed spans rather than responsibilities of the Agent loop.
