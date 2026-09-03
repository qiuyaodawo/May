# ADR 0005：Observability 实现 Core 拥有的可选 Tracing Port

[English](../../../en/architecture/decisions/0005-observability-is-an-optional-core-port.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-03

## 背景

May 需要跨 Run、模型调用、工具、权限、Context、application 和未来 MCP 调用的因果关系、
耗时与状态数据。现有实时 event 和持久化 Session event 具有不同的可靠性与隐私语义；
把其中任意一条 event stream 隐式当成 audit/telemetry backend 会混合这些职责。

如果让 Core 依赖 exporter 或外部 tracing SDK，可选遥测会变成强制依赖，Core 的最小边界
会被削弱；而 May 专用 processor 又需要 Core event 和执行类型，因此还可能形成循环依赖。

## 决策

Core 拥有小型同步 `Tracer`/`TraceSpan` port，并显式传播 `TraceContext`。Runtime 的
instrumentation 调用采用 fail-open 语义。默认只记录不含内容的标识、数量、状态、usage
和错误类型/错误码，不记录 prompt、message、reasoning 或工具输入输出。

可选 `@may/observability` package 依赖 Core，实现采样、不可变完成 span、内存与
串行/有界 processor，以及基础 exporter。异步导出属于 processor，不能给 Agent 执行
增加 backpressure，也不能让 exporter failure 变成 Agent failure。

Tracer 和 processor 生命周期由调用方拥有。`AgentDefinition` 可以捕获 tracer，但关闭
某个 application 不会关闭仍被其他 application 共享的 tracer。产品应在真正的 ownership
边界 flush 并 shutdown processor。

Trace 是允许采样或丢弃的运行数据。Session 和 permission event 仍是持久化事实来源。
厂商集成通过自定义 processor/exporter 完成，相关 SDK 类型不进入 Core API。

## 后果

- Core 不产生对 `@may/observability` 或厂商 SDK 的 runtime dependency；
- Core、Session、Application、Provider 和远程工具可以无进程全局状态地显式传播同一
  trace context；
- tracer 或 exporter 故障不能使 Run 失败；
- processor counter 会暴露缓冲压力，但不会阻塞 Agent；
- 产品必须让自定义 attribute 不含敏感内容，或应用自己的隐私策略；
- metrics、dashboard 和厂商专用 exporter 是基于完成 span 的 adapter，不属于 Agent Loop。
