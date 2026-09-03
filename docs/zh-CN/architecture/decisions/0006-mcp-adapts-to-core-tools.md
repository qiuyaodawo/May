# ADR 0006：MCP 适配为 Core 工具

[English](../../../en/architecture/decisions/0006-mcp-adapts-to-core-tools.md) | **简体中文**

- 状态：已接受
- 日期：2026-09-03

## 背景

May 需要使用 Model Context Protocol server 的能力。如果直接把 MCP 行为加入 Agent
循环，会让每个 Agent 都耦合协议 SDK、产生重复工具执行路径，并可能绕过已有的
permission、scheduling、cancellation、Session 与 tracing 行为。

MCP stdio 连接还拥有一个生命周期长于单次工具调用或 Session 的子进程。不同 server
的工具名可能冲突；server 提供的 descriptor 也是不可信、模型可见的 input。

## 决策

建立可选 `@may/mcp` package。它依赖 `@may/core`，把 MCP server 的工具描述与调用
适配到 Core 既有 `Tool` 契约。Core 和 `@may/application` 都不依赖 MCP。

应用打开实例级 MCP client pool，通过 `ToolRegistry` 组合带 namespace 的工具快照，
并在产品 ownership 边界关闭 pool。因此所有调用仍经过选定的 Core `ToolExecutor` 与
`ToolScheduler`，产品继续控制 permission policy。Cancellation 和 trace context 显式
传播。

首个实现支持 stdio 初始化、聚合 `tools/list` 与 `tools/call`，使用启动快照、确定性且
provider-safe 的名称、冲突失败、有界错误细节，以及显式连接/进程关闭。Resources、
prompts、HTTP、server 实现和动态列表刷新延后。

## 后果

- 不使用 MCP 的 Agent 不会加载其 SDK 或进程管理代码。
- MCP 工具复用已有 permission、scheduling、event、cancellation 与 Session 行为，
  不创建并行 runtime。
- 应用必须拥有并关闭 pool；Session 不拥有共享 MCP 进程。
- 本阶段远程工具列表变化后需要重新连接或重启。
- Server id 与远程名称成为预览版模型可见命名契约，冲突会 fail fast。
- MCP server 仍是可信可执行依赖；把它适配为 Tool 不会提供 sandbox，也不会让其描述
  自动变得可信。
