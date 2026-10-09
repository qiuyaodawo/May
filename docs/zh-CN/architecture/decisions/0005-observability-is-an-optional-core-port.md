# ADR 0005：Observability 实现 Core 拥有的可选 Tracing 接口

[English](../../../en/architecture/decisions/0005-observability-is-an-optional-core-port.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-03

## 背景

May 需要观察 Run、模型调用、工具、权限、Context、应用与 MCP 调用的因果关系、
耗时和状态。实时事件、持久化 Session 事件与遥测各自具有不同的可靠性和隐私要求。
可选遥测需要保持独立的导出依赖与处理生命周期。

## 决策

Core 拥有同步的 `Tracer`/`TraceSpan` 接口，并明确传播 `TraceContext`。
Instrumentation 使用 fail-open 语义，默认记录不包含内容的标识、数量、状态、
usage 和错误类型/错误码；排除 prompt、message、reasoning 及工具输入输出。

可选 `@may/observability` 依赖 Core，实现采样、不可变的完成 span、内存处理器、
串行有界处理器与基础 exporter。异步导出由 processor 负责，缓冲压力和导出故障
不得影响 Agent 执行。

Tracer 与 processor 的生命周期由调用方拥有。`AgentDefinition` 可以捕获 tracer，
应用关闭后共享 tracer 继续由拥有者管理。产品在对应所有权范围内刷新并关闭 processor。

Trace 可以被采样或丢弃。Session 与权限事件提供持久化事实。厂商集成通过自定义
processor/exporter 完成，厂商 SDK 类型保持在适配层内。

## 后果

- Core 不依赖 `@may/observability` 或厂商 SDK。
- Core、Session、Application、Provider 与远程工具明确传播同一 trace context。
- Tracer 或 exporter 故障不会使 Run 失败。
- Processor 计数器显示缓冲压力，Agent 继续执行。
- 产品需要管理自定义属性的隐私，保持属性不含敏感内容。
- 指标、仪表板与厂商 exporter 基于完成 span 提供。

Processor 配置与关闭步骤见[可观测性](../../guides/observability.md)。
