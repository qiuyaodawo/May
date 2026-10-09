# May 文档

[English](../en/README.md) | **简体中文**

May 提供可组合的软件包，用于模型和工具执行、持久对话、权限及应用生命周期。
根据任务和已有知识选择页面。公共 API 与持久化格式当前处于开发预览阶段。

## 教程

- [运行第一个 Agent 应用](getting-started.md)：调用模型、执行工具、保存历史并
  重新打开 Session。

## 操作指南

### 应用与开发

- [使用 MaybeCode](guides/maybecode.md)：启动编码 Agent，使用终端操作。
- [使用 MaybeClaw](guides/maybeclaw.md)：配置 Gateway、Agent、会话和渠道。
- [开发和验证仓库](guides/repository-development.md)：构建、测试、检查 CI，以及
  选择需要额外环境的检查。
- [构建 Agent](guides/building-an-agent.md)：选择模型、工具、权限、Context、存储和 UI。
- [配置与查看 MaybeCode 指令](guides/maybecode-instructions.md)。
- [使用 Git 工作区与 checkpoint](guides/git-workspaces.md)。
- [配置共享 WebUI](guides/web-ui.md)。

### 扩展与运行 Agent

- [组合插件、服务和生命周期 Hooks](guides/plugins.md)。
- [编写模型适配器](guides/custom-model.md)。
- [编写工具](guides/custom-tool.md)。
- [编写 Context 管理](guides/custom-context.md)。
- [编写 Session 存储](guides/custom-storage.md)。
- [编写 UI](guides/custom-ui.md)。
- [配置权限策略](guides/permission-policy.md)。
- [核查中断后的工具结果](guides/recovery.md)。
- [设置 Run 预算](guides/run-budgets.md)。
- [使用 Agent Skills](guides/skills.md)。
- [管理目标](guides/goals.md)。
- [配置时间与事件触发](guides/scheduler.md)。
- [返回图片](guides/images.md)。
- [配置 Tracing](guides/observability.md)。
- [组合模型能力与诊断](guides/model-telemetry-integration.md)。
- [评估 Agent 行为](guides/eval.md)。

### 协调 Agent

- [构建多 Agent 任务图](guides/coordination.md)。
- [配置共享资源和任务工作区](guides/coordination-resources.md)。
- [管理 Attempt 与任务图修订](guides/coordination-lifecycle.md)。
- [连接远程叶子 Worker](guides/coordination-remote.md)。
- [运行 MaybeCode 团队](guides/maybecode-team.md)。
- [在普通请求中委派子 Agent](guides/subagent-delegation.md)。
- [配置团队计划](guides/maybecode-team-plan.md)。
- [阅读团队报告与验收](guides/maybecode-team-verification.md)。
- [授权团队编码](guides/maybecode-team-coding.md)。
- [恢复团队执行](guides/maybecode-team-recovery.md)。

### 连接 MCP 服务

- [连接 MCP 工具与宿主服务](guides/mcp.md)。
- [配置 MCP 认证](guides/mcp-auth.md)。
- [管理 MCP 长时间任务](guides/mcp-tasks.md)。
- [提供 MCP Apps 宿主](guides/mcp-apps.md)。
- [导出 MCP server](guides/mcp-server.md)。

## 参考文档

- [软件包与公开入口](reference/packages.md)。
- [Provider、模型和应用配置](reference/configuration.md)。
- [兼容性、稳定性与运行环境](reference/compatibility.md)。
- [MCP 能力与协议兼容性](reference/mcp-capabilities.md)。

各个软件包的 README 描述具体导出。导入时使用 `exports` 声明的入口。

## 概念与架构说明

- [Agent 定义、Application 与 Workspace](concepts/agent-application.md)。
- [Session、Run 与 Step](concepts/session-run-step.md)。
- [Context 与持久化历史](concepts/context-and-history.md)。
- [事件与持久化](concepts/events.md)。
- [Runtime 与 Session 架构](architecture/runtime-session.md)。
- [Session 分支与 Git checkpoint](architecture/session-forks-and-checkpoints.md)。
- [插件架构](architecture/plugins.md)。
- [架构决策](architecture/decisions/README.md)。

## 维护文档

英文与简体中文页面保持相同相对路径。遵守[文档维护规则](../AGENTS.md)，同步更新
两种语言，并执行 `pnpm docs:check`。示例行为和链接锚点需要单独核查。
