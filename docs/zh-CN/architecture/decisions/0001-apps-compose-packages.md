# ADR 0001：应用组合可复用 package

[English](../../../architecture/decisions/0001-apps-compose-packages.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

May 既是 Agent 框架，也是包含可执行参考产品的 monorepo。最初在 MaybeCode 中实现的
逻辑同时包含可复用的执行、Session 和 UI 行为，使其他 Agent 难以判断哪些能力可以
直接使用，而无需导入产品代码。

## 决策

可复用的契约和实现放在 `packages/`；可执行产品放在 `apps/`，由应用选择、配置并
适配这些 package。依赖只能从应用指向 package，任何可复用 package 都不得导入应用。

具体 prompt、命令、配色、模型 profile 和默认权限等产品策略保留在应用内；只有在
它真正成为可参数化的通用组件后，才提取到 package。

## 后果

- 其他 Agent 可以使用 May package，而不依赖 MaybeCode。
- Package API 需要独立文档和聚焦测试。
- MaybeCode 同时承担参考组合和集成验证的角色。
- 即使底层机制移入 package，一些兼容适配器仍会保留在 MaybeCode。
- Package 可以包含可选的领域组件，例如编码工具 renderer，但不得导入产品实现代码。
