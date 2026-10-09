# ADR 0006：MCP 适配为 Core 工具

[English](../../../en/architecture/decisions/0006-mcp-adapts-to-core-tools.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-03

## 背景

May 使用 Model Context Protocol server 的能力。远程工具需要经过已有的权限、
调度、取消、Session 与 tracing 流程。Stdio 连接还管理生命周期长于单次调用的
子进程。不同 server 的工具名可能冲突，远程描述属于不可信的模型可见输入。

## 决策

可选 `@may/mcp` 依赖 `@may/core`，把远程工具描述与调用适配为 `Tool`。
Core 与 `@may/application` 的依赖独立于 MCP。

应用打开实例级连接池，通过 `ToolRegistry` 组合具有名称空间的工具快照，在产品
所有权范围内关闭连接池。调用经过选定的 `ToolExecutor` 与 `ToolScheduler`，
产品拥有权限策略，并明确传播取消信号与 trace context。

Adapter 负责传输初始化、目录发现与远程调用，提供符合 Provider 要求的确定性名称、
冲突检查、大小受限的错误信息和明确的连接关闭。刷新目录影响后续 Run。当前支持的
传输与能力见 [MCP 能力参考](../../reference/mcp-capabilities.md)。

Server 默认 required；应用可以标记 optional，使连接失败时其他工具继续可用。
连接池保留大小受限且已经清理敏感信息的 stderr，并提供状态快照与连接生命周期事件。
产品通过这些接口获取诊断信息。

## 后果

- 使用 MCP 的应用负责加载其 SDK 与连接管理。
- 远程工具复用权限、调度、事件、取消和 Session 行为。
- 应用拥有并关闭连接池，共享 MCP 进程由产品管理。
- Optional server 故障单独记录，required server 故障直接终止启动。
- 明确刷新或重新连接后，新目录供后续 Run 使用。
- Server ID 与远程工具名属于预览版模型可见命名规则，冲突立即报错。
- MCP server 以可执行依赖管理；需要单独管理执行隔离与远程描述的信任范围。

## 相关接口

Host 交互、Tasks、隔离 Apps 与独立 server 导出在 Core 外实现，通过应用组合启用。
详见 [MCP 指南](../../guides/mcp.md)和 [server 指南](../../guides/mcp-server.md)。
