# ADR 0003：共享生命周期属于 `@may/application`

[English](../../../en/architecture/decisions/0003-headless-application-lifecycle.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

Core 负责一次模型与工具执行循环。完整 Agent 产品还需要持久化 Session 的创建与
恢复、审批事件转发、Context 压缩持久化、取消、Catalog 摘要及串行化 Session
切换。共享应用层统一这些生命周期操作及关闭顺序。

## 决策

在 Core 上方提供 headless 应用层：

- `AgentApplication` 拥有一个活动 Session 及其运行资源。
- `AgentWorkspace` 管理活动 Session 选择、Catalog 投影与串行状态迁移。
- 产品注入 Model、Tool、指令、权限策略、Context factory 与 store。
- 产品专属状态使用 `runStateTransition`，需要重建运行环境的变化使用
  `transitionApplication`。

产品选择 Provider、prompt、UI 与编码策略。可复用行为组合见
[ADR 0004](0004-agent-definitions-and-tool-registries.md)。

## 后果

- 应用共享排序、取消、持久化与关闭逻辑。
- UI 可以面向 `AgentController` 等 headless 接口编写。
- Core 可以用于临时任务与完全自定义的运行环境。
- 产品映射通用事件或提供命名策略时，需要自己的组合封装。
- `AgentDefinition` 组合行为，应用另行提供 Session 存储与身份。详见
  [构建 Agent](../../guides/building-an-agent.md)。
