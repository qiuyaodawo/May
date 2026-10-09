# 架构决策记录

[English](../../../en/architecture/decisions/README.md) | **简体中文**

这些记录说明 May 包与应用的依赖方向、生命周期所有权及可选集成范围。具体实现见
[包目录](../../reference/packages.md)与[运行架构](../runtime-session.md)。

## 状态

- **已接受（Accepted）** —— 当前项目方向。
- **提议中（Proposed）** —— 仍在讨论，尚未形成约束。
- **已取代（Superseded）** —— 已由新的 ADR 取代，并应链接到新记录。

## 记录

| ADR | 状态 | 决策 |
| --- | --- | --- |
| [0001](0001-apps-compose-packages.md) | 已接受 | 应用通过单向依赖组合可复用包 |
| [0002](0002-agent-ui-stays-in-may-tui.md) | 已接受 | Agent 感知的终端组件保留在 `@may/tui` |
| [0003](0003-headless-application-lifecycle.md) | 已接受 | 共享 Session 编排属于 `@may/application` |
| [0004](0004-agent-definitions-and-tool-registries.md) | 已接受 | Agent definition 与工具 registry 是实例级可复用组合对象 |
| [0005](0005-observability-is-an-optional-core-port.md) | 已接受 | Observability 实现 Core 拥有的可选 tracing port |
| [0006](0006-mcp-adapts-to-core-tools.md) | 已接受 | MCP server 适配为 Core 工具 |

## 添加记录

使用下一个四位编号，包含状态、日期、背景、决策和后果，并链接相关包与指南。
架构决策变化时，新增记录并提供明确的替代关系。使用步骤放在对应指南中，API
演进时检查 ADR 当前适用范围。
