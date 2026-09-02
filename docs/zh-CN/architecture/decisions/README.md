# 架构决策记录

[English](../../../architecture/decisions/README.md) | **简体中文**

本目录记录会约束多个 May package 或应用的架构决策。ADR 解释某个边界为何存在，
避免后续重构在无意中破坏它。

## 状态

- **已接受（Accepted）** —— 当前项目方向。
- **提议中（Proposed）** —— 仍在讨论，尚未形成约束。
- **已取代（Superseded）** —— 已由新的 ADR 取代，并应链接到新记录。

## 记录

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](0001-apps-compose-packages.md) | 已接受 | 应用通过单向依赖组合可复用 package |
| [0002](0002-agent-ui-stays-in-may-tui.md) | 已接受 | Agent 感知的终端组件保留在 `@may/tui` |
| [0003](0003-headless-application-lifecycle.md) | 已接受 | 共享 Session 编排属于 `@may/application` |

## 添加记录

使用下一个四位编号，并包含背景、决策、后果和状态。ADR 应记录架构权衡，而不是
普通实现细节。决策发生变化时，应新增 ADR 并将旧记录标记为已取代，而不是重写历史。
