# ADR 0002：Agent 终端 UI 保留在 `@may/tui`

[English](../../../en/architecture/decisions/0002-agent-ui-stays-in-may-tui.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

终端 Agent 需要终端基础组件、保留的对话状态、事件投影与工具呈现。这些组件
共享终端依赖，可以在一个 UI 包内提供不同的模块入口。

## 决策

终端基础组件与 Agent 呈现组件保留在 `@may/tui`，通过明确的子路径导出：

- `@may/tui`：终端基础组件。
- `@may/tui/transcript`：Agent 事件投影与保留的对话记录。
- `@may/tui/tool-renderers`：实例级工具呈现。
- `@may/tui/slash-commands` 与 `@may/tui/list-selection`：可复用输入状态。

应用注入产品标签、主题、命令、布局与额外事件提示。非终端 UI 直接使用
headless controller，其依赖独立于 `@may/tui`。

## 后果

- 终端使用方通过一个包查找这些模块。
- 基础终端 API 与 Agent 呈现 API 在包内具有明确的模块边界。
- 标准编码 renderer 提供可选的编码领域依赖，调用方可以替换实例级 Registry。
- 产品 UI 行为由应用拥有，通用对话组件保持可复用。

Controller 与 renderer 的接入方式见[自定义 UI](../../guides/custom-ui.md)。
