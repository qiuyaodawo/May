# ADR 0003：共享生命周期属于 `@may/application`

[English](../../../en/architecture/decisions/0003-headless-application-lifecycle.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

Core 有意只负责一套模型/工具执行循环。完整 Agent 产品还需要持久化 Session 的创建
与恢复、审批事件转发、Context 压缩持久化、取消、Catalog 摘要和串行化 Session
切换。若这些编排留在 MaybeCode，其他应用必须重复实现同样的生命周期和容易出错的
关闭顺序。

## 决策

在 Core 上方提供 headless 应用层：

- `AgentApplication` 拥有一个活动 Session 及其运行时资源；
- `AgentWorkspace` 管理活动 Session 的选择、Catalog 投影和串行状态迁移；
- 产品注入模型、工具、指令、策略、Context factory 和 store；
- 产品专属状态使用 `runStateTransition`，需要重建运行时的变化使用
  `transitionApplication`。

这一层不定义统一的声明式 Agent definition、provider registry、默认 prompt、UI 或
编码策略。

## 后果

- 应用共享排序、取消、持久化与关闭逻辑。
- UI 可以面向 `AgentController` 风格的 headless 契约。
- Core 仍可用于临时任务和完全自定义的运行时。
- 当产品需要映射通用事件或提供命名策略时，仍需一个很薄的组合 wrapper。
- 声明式 Agent definition、工具 registry 和分布式执行仍是未来可能的层级，而不是
  被悄悄加入 Core 的职责。
