# @may/plugin-observability

`createObservabilityPlugin(options)` 提供 `observabilityService` 和 `services.tracer`。
Setup 创建 JSONL exporter、batch processor 与 tracer，插件清理时写入尚未导出的
记录并关闭 processor。选项配置数据目录、文件、采样比例、保留时间、batch 限制和
resource attributes。Trace 记录不包含用户消息与工具内容。

service 同时提供数量受限的 `diagnostics` 与独立记录的 `metrics`。
`maxDiagnosticSpans`、`diagnosticRetentionMs` 与 `maxMetricSeries` 配置
保留范围与容量。本地诊断记录独立于导出采样。`processor.getDiagnostics()`
报告队列数量、导出失败、超时和丢弃记录。自定义共享 service 可以省略 diagnostics
或者 metrics，宿主通过可选字段查询。

`createObservabilityHostPlugin(options)` 为工作区生命周期提供 `observabilityHostService`。
`createSharedObservabilityPlugin(resources)` 向 application 提供同一个实际 tracer，
processor 继续由原 host 管理。这样可以切换 Session，同时保持 MCP 或其他 application
使用的 exporter。

参见 [English version](README.md)。
