# @may/plugin-observability

`createObservabilityPlugin(options)` provides `observabilityService` and
`services.tracer`. Setup creates a JSONL exporter, batch processor, and tracer;
plugin cleanup flushes and shuts down the owned processor. Options configure
the data directory, file, sampling ratio, retention, batch limits, and resource
attributes. Trace records remain content-free.

The service also supplies bounded `diagnostics` and independently recorded
`metrics`. Options `maxDiagnosticSpans`, `diagnosticRetentionMs` and
`maxMetricSeries` set their retention and capacity. Local diagnostic spans are
retained independently of export sampling. `processor.getDiagnostics()` reports
queue size, export failures, timeouts and dropped records. Custom shared services
may omit diagnostics or metrics; hosts query them through optional fields.

`createObservabilityHostPlugin(options)` provides `observabilityHostService` for
a workspace lifetime. `createSharedObservabilityPlugin(resources)` provides the
same actual tracer to an application while the original host retains processor
ownership. This allows Session changes without closing exporters used by MCP
or another application.

Read the [Chinese version](README.zh-CN.md).
