# Package 参考

[English](../../en/reference/packages.md) | **简体中文**

May 使用 pnpm workspace。可复用框架代码位于 `packages/`，可执行产品位于
`apps/`。应用可以依赖 package，但 package 不得导入应用。

所有 package 当前版本均为 `0.1.0`。在把公共接口或持久化格式视为稳定契约之前，
请先阅读[兼容性与稳定性](compatibility.md)。

## 选择最小可用层级

| 目标 | 从这里开始 | 通常还需加入 |
| --- | --- | --- |
| 在内存中运行一次模型/工具循环 | `@may/core` | 一个 provider adapter |
| 定义可复用的 Agent 行为与策略 | `@may/application` 的 `defineAgent()` | `@may/core` 的 `ToolRegistry` |
| 构建 headless、可持久化的单 Session Agent | `AgentDefinition.open()` 或 `AgentApplication.open()` | `@may/session`、`@may/context`、权限和工具 |
| 在一个 workspace 中管理多个 Session | `@may/application` | `@may/session/catalog` 的 `SessionCatalog` |
| 构建终端 Agent | Headless application controller | `@may/tui`，可选 `@may/keybindings` |
| 构建编码 Agent | Headless application controller | `@may/coding-tools` 和执行隔离策略 |
| 从 May 配置中选择模型 | `@may/config` | `@may/providers` |
| 让模型查询持久化历史 | `@may/session-tools` | 活动 `Session` 或 `AgentApplication` |
| 追踪 Agent 延迟与结果 | Core 的 `Tracer` port | `@may/observability` processor 和 exporter |
| 使用 MCP server 工具 | `@may/mcp` | `ToolRegistry`、permissions 和可选 tracing |

调用方希望完全控制运行时生命周期时使用 `@may/core`；需要 Session、审批、Context
管理和有序关闭的应用通常应从 `@may/application` 开始。

## 运行时与应用

### `@may/core`

与 provider 无关的执行内核：

- `May`、`Model`、`Tool`、`Context`、`ToolExecutor` 和 `ToolScheduler` 契约；
- 实例级 `ToolRegistry` 与 `DuplicateToolNameError`；
- Run 与 Step 执行、流式事件和取消；
- 工具调度与标准化消息；
- 适合小型或临时集成的 `InMemoryContext`。

`ToolRegistry` 实现 `Iterable<Tool>`，并提供 `register()`、原子 `registerAll()`、
`has()`、`get()`、`require()`、`size`、`names()`、`values()`、`definitions()`、
`clone()`、迭代和静态 `compose()`。有歧义的名字会抛出 `DuplicateToolNameError`。
`May` 接受任何 `Iterable<Tool>` 并在构造时快照集合；registry 不是进程级全局状态。
Registry 保留原始 Tool 身份，同时检查注册后的 readonly descriptor 是否仍与登记时
一致；schema 只进行引用检查，不会被深度冻结。

Core 不负责持久化 Session、provider 选择、产品配置、权限策略或 UI。参阅
[Core package README](../../../packages/core/README.md)。

### `@may/application`

位于 Core 之上的 headless 编排层：

- `AgentDefinition` 和 `defineAgent()` 将可复用行为/策略（包括可选 tool executor 与
  scheduler）与 Session 输入分开；
- `AgentApplication` 拥有一个活动且可持久化的 Session；
- `AgentWorkspace` 管理活动 Session 选择与 Catalog 更新；
- `AgentController` 和 `AgentWorkspaceController` 定义与 UI 无关的控制面；
- `AsyncStateSerializer` 串行化产品和 Session 状态迁移；
- Context 检查与压缩结果通过 Session 持久化；
- 可选安装 `session_history` 和工具呈现支持。

Definition 创建时会快照工具 iterable；每次 `open({ store, ... })` 创建独立的
application/Session 生命周期。Model、Context factory、executor、scheduler 等有状态
协作者仍由调用方拥有，不会因多次打开而自动克隆。模型、工具、prompt、策略与存储仍
由产品注入。参阅
[Agent 与 Application](../concepts/agent-application.md)和
[package README](../../../packages/application/README.md)。

### `@may/observability`

这是 Core `Tracer` port 的可选 fail-open tracing 实现，提供 `BasicTracer`、确定性采样、
不可变完成 span、内存与串行/有界 processor，以及内存/JSON console/本地 JSONL exporter。Core、
Application、Session、模型和工具 context 会显式传播 trace identity，不使用进程全局
tracer。Processor 生命周期仍由调用方拥有。参阅
[可观测性与 Tracing](../guides/observability.md)。

### `@may/mcp`

可选的 Model Context Protocol client 集成。它连接配置的 stdio 或
Streamable HTTP 端点，协商协议并执行 `tools/list`，再把每个发现的工具适配为 Core 既有的 `Tool` 接口。模型可见名称带
namespace 并检查冲突；调用会转发 cancellation 和 progress，可选 MCP span 使用注入
的 Core tracer。Client pool 拥有它启动的进程，打开它的应用必须负责关闭；pool 还会
暴露 server 状态和连接生命周期事件，并为诊断保留有界、已净化的 stderr 末尾片段。
参阅 [MCP 工具](../guides/mcp.md)。

## 状态与策略

### `@may/context`

提供可替换的 Context factory 和内置压缩策略，包括内存托管 Context、检查、自动
压缩、summary-tail、history-reference、裁剪以及模型驱动的摘要组件。Context 是
当前模型可见视图，并非完整的 Session 持久化历史。参阅
[Context 与持久化历史](../concepts/context-and-history.md)。

### `@may/session`

负责持久化的对话身份与事实：

- 串行提交和 continuation；
- Session 事件历史与基于 cursor 的查询；
- 内存存储；
- 通过 `@may/session/file-store` 提供可选 JSONL 文件存储；
- 通过 `@may/session/catalog` 提供内存和文件 Catalog。

Catalog 用于发现 Session；Session Store 用于读取或追加属于某个 Session 的事实。

### `@may/permissions`

实现 headless `ToolExecutor`：评估 `PermissionPolicy`、发布审批请求并接受允许/拒绝
决定。它支持进程内 Session grant，但既不是 UI，也不是 sandbox。

### `@may/config`

加载并校验 provider 连接、model profile 与应用自有配置。JSON Schema 通过
`@may/config/schema` 导出。参阅[配置参考](configuration.md)。

运行时的 `apps` 值是通用结构。随项目提供的编辑器 schema 还描述了 MaybeCode 的
产品设置；第三方应用必须自行校验它们的应用配置区段。

## 模型与 Provider

### `@may/providers`

提供 `ProviderAdapterRegistry`、内置 adapter 注册、按配置选择模型和解析 capability。
Registry 是普通实例，不是进程级全局状态。

协议实现也可分别使用：

| Package | 协议 |
| --- | --- |
| `@may/provider-openai` | OpenAI Responses API 与原生压缩 |
| `@may/provider-openai-compatible` | Chat Completions 兼容协议的共享辅助能力 |
| `@may/provider-anthropic` | Anthropic Messages API |
| `@may/provider-deepseek` | DeepSeek Chat |
| `@may/provider-zhipu` | 智谱 GLM Chat |
| `@may/provider-kimi` | Kimi Chat |

应用可以直接使用具体 adapter，也可以通过 `@may/providers` 选择。

## 工具

### `@may/coding-tools`

提供受 workspace 约束的读取、编辑、写入和 shell 工具，以及可复用的指令加载与编码
变更预览。子路径导出包括：

- `@may/coding-tools/instructions`；
- `@may/coding-tools/change-preview`。

Shell 工具以 May 进程的宿主权限执行，明确不属于 sandbox。参阅
[自定义工具](../guides/custom-tool.md)。

### `@may/session-tools`

提供有边界、只读的 `session_history` 工具。`AgentApplication` 可以自动安装它；
低层应用也可以直接构造。

## 终端 UI

### `@may/tui`

同时包含底层终端组件和 Agent 感知投影：

| 导出 | 用途 |
| --- | --- |
| `@may/tui` | 组件、renderer、editor、focus、scroll 和 terminal driver |
| `@may/tui/node-terminal` | 面向行的 Node terminal adapter |
| `@may/tui/transcript` | Session/live-event transcript store 与 retained view |
| `@may/tui/tool-renderers` | 实例级工具呈现 renderer |
| `@may/tui/slash-commands` | 命令解析与补全状态 |
| `@may/tui/list-selection` | 带过滤的列表/选择器状态 |

产品命令、标签、布局和 controller 调用仍属于应用代码。图形或远程 UI 应使用
headless controller，无需依赖 `@may/tui`。

### `@may/keybindings`

把特定上下文中的按键序列映射为语义化 UI action。它是可选层，不负责终端渲染或
产品命令。

## 参考产品

`@may/maybecode` 是主要的编码 Agent 应用和集成示例。它使用上述 package，但使用
May 并不需要依赖它。更小的 `@may/cli` 展示了如何直接使用 Core。

接下来可阅读[快速开始](../getting-started.md)或
[构建 Agent](../guides/building-an-agent.md)。
