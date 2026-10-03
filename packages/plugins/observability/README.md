# @may/plugin-observability

`createObservabilityPlugin(options)` provides `observabilityService` and
`services.tracer`. Setup creates a JSONL exporter, batch processor, and tracer;
plugin cleanup flushes and shuts down the owned processor. Options configure
the data directory, file, sampling ratio, retention, batch limits, and resource
attributes. Trace records remain content-free.

`createObservabilityHostPlugin(options)` provides `observabilityHostService` for
a workspace lifetime. `createSharedObservabilityPlugin(resources)` provides the
same actual tracer to an application while the original host retains processor
ownership. This allows Session changes without closing exporters used by MCP
or another application.

Read the [Chinese version](README.zh-CN.md).
