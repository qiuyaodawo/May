# May 文档

[English](../en/README.md) | **简体中文**

May 是一个可组合的 Agent 框架。这些文档介绍如何将各个 package 组装成应用、
运行时状态如何分层，以及哪些接口可以安全地扩展。

## 从这里开始

1. [快速开始](getting-started.md) —— 定义可复用 Agent、组合工具，并打开可持久化的
   `AgentApplication`。
2. [构建 Agent](guides/building-an-agent.md) —— 选择模型、工具、指令、Context、
   权限、Session 存储和 UI。
3. [Package 参考](reference/packages.md) —— 为应用选择最小且合适的 May 层级。

## 核心概念

- [Agent 与 Application](concepts/agent-application.md)
- [Session、Run 与 Step](concepts/session-run-step.md)
- [Context 与持久化历史](concepts/context-and-history.md)
- [事件](concepts/events.md)
- [Runtime 与 Session 架构](architecture/runtime-session.md)

## 扩展指南

- [多 Agent 任务图](guides/coordination.md)
- [共享预算、产物与任务工作区](guides/coordination-resources.md)
- [Attempt 与任务图修订](guides/coordination-lifecycle.md)
- [远程叶子 Worker](guides/coordination-remote.md)
- [只读 MaybeCode 团队任务](guides/maybecode-team.md)

- [崩溃恢复](guides/recovery.md)
- [运行预算](guides/run-budgets.md)
- [Agent Skills](guides/skills.md)

- [自定义模型](guides/custom-model.md)
- [自定义工具](guides/custom-tool.md)
- [自定义 Context](guides/custom-context.md)
- [自定义 Session 存储](guides/custom-storage.md)
- [自定义 UI](guides/custom-ui.md)
- [权限策略](guides/permission-policy.md)
- [可观测性与 Tracing](guides/observability.md)
- [MCP 工具](guides/mcp.md)
- [MCP 认证](guides/mcp-auth.md)
- [MCP Host 路线与验收](architecture/mcp-host-roadmap.md)

## 参考

- [Packages](reference/packages.md)
- [配置](reference/configuration.md)
- [兼容性与稳定性](reference/compatibility.md)
- [架构决策记录](architecture/decisions/README.md)

## 参考应用

- [MaybeCode](../../apps/maybecode/README.md) 是完整的终端编码 Agent 组合示例。
- [May CLI](../../apps/cli/README.md) 是更小的 Core 直接使用示例。

各 package 的 README 仍是具体导出的最近参考。只有 package `exports` 中声明的
入口才属于公共 API；当前开发预览版的保证请参阅
[兼容性与稳定性](reference/compatibility.md)。

## 语言与维护

英文文档位于 `docs/en/`；完整简体中文镜像位于 `docs/zh-CN/`，并保持相同
相对路径。行为变化时应同步更新一对文件，并在提交文档前运行 `pnpm docs:check`。
