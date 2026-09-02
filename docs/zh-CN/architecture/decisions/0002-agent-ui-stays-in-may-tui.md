# ADR 0002：Agent 终端 UI 保留在 `@may/tui`

[English](../../../en/architecture/decisions/0002-agent-ui-stays-in-may-tui.md) | **简体中文**

- **状态：** 已接受
- **日期：** 2026-09-02

## 背景

MaybeCode 最初包含 retained transcript 状态、transcript view 和工具 renderer。这些
组件同样适用于其他终端 Agent。项目曾考虑建立独立的 `@may/agent-tui`，但 May 本身
就是 Agent 框架，再增加一个 package 会人为割裂终端基础组件和通常与其一起渲染的
Agent 投影组件。

## 决策

两个层次都保留在现有 `@may/tui`，并通过明确的子路径导出：

- `@may/tui`：终端基础组件；
- `@may/tui/transcript`：Agent 事件投影与 retained transcript；
- `@may/tui/tool-renderers`：实例级工具呈现；
- `@may/tui/slash-commands`、`@may/tui/list-selection`：可复用输入状态。

产品负责注入标签、主题、命令、布局和额外事件提示。非终端 UI 直接使用 headless
controller，不依赖 `@may/tui`。

## 后果

- 不再增加需要发现和版本管理的 `@may/agent-tui`。
- 底层终端 API 与 Agent 感知 API 仍在同一 package 内通过模块边界清晰分隔。
- 标准编码 renderer 使 `@may/tui` 带有可选的编码领域依赖；调用方可替换实例级 registry。
- 不能仅为减少应用代码就把产品 UI 行为塞入通用 transcript。
