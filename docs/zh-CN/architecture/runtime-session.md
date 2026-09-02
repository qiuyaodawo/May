# Runtime 与 Session 边界

[English](../../en/architecture/runtime-session.md) | **简体中文**

May 使用四个生命周期层级：

```text
Agent definition -> Session -> Run -> Step
```

应用编排包围这些层级，而不是增加另一层模型执行概念。`AgentApplication` 拥有一个
活动 Session；产品创建、恢复或重新配置 Session 时，`AgentWorkspace` 负责选择并
替换活动 application。

## 术语

### Agent definition

决定 Agent 行为的可复用配置，包括模型、工具、指令和默认执行策略。它本身没有
对话身份，也不表示正在执行的工作。

### Session

长期存在的对话和工作身份。Session 跨多个 Run 持有历史和 Session 级状态，也可以
在没有活动 Run 时存在。持久化、恢复、fork、Context checkpoint 和 Session 级权限
grant 都属于这一层。

一个 Session 最多只能有一个活动 Run。Session 存储是独立能力，因此内存 Session
无需引入文件系统依赖。

### Run

由一次用户输入启动的执行。Run 持续到模型完成、达到 Step 上限、失败或被取消。
`May.run()` 及其事件流构成这一边界。

### Step

一次模型请求，以及执行该响应中全部工具调用的过程。工具结果可能在同一 Run 中触发
下一个 Step。因此 Step 限制约束模型/工具迭代次数，而不是工具数量；一个 Step 可以
包含多个工具调用。

## Package 职责

可复用代码位于 `packages`，可执行产品组合位于 `apps`。依赖规则为：

```text
apps/*
  |-> @may/application -> context / session / permissions / core /
  |                      session-tools
  |-> @may/tui         -> coding-tools / keybindings / session /
  |                      permissions / core
  `-> provider / tool / config packages
```

这是分层示意，并不要求每个 package 都依赖其右侧的所有 package。不变条件是：可复用
package 不导入应用，特别是没有 package 导入 `apps/maybecode`。

### `@may/core`

Core 负责活动执行：

- model、tool 和 context 契约；
- Run/Step 循环；
- 实时 Run 事件与取消；
- 通过可替换 executor 和 scheduler seam 分派工具；
- 标准化多模态内容，以及 provider 自有转换边界。

Core runtime 默认拒绝重叠 Run，因为它只拥有一个可变 Context。Session 还会把提交
串行化为生命周期策略。

Core 不负责 Session 发现、持久化、恢复、fork、UI 状态或某种具体权限策略。它必须
继续支持临时的一次性 Run。

### `@may/context`

Context package 提供 factory 和 Core 最小 `Context` 契约的可复用实现。应用可以
替换模型可见历史的保存或选择方式，而无需修改 Agent 循环。它不拥有 Session 身份
或持久化历史。

Factory 还可以暴露 `ContextController`，供应用检查、手动压缩以及模型调用前的自动
压缩。Core 仅在请求 snapshot 时传递 Run metadata 和取消信号；策略选择和持久化的
替换事件不属于 Core 最小契约。

Model adapter 可以选择暴露 provider 原生 Context compactor。Core 只定义不透明
capability 边界；`@may/context` 将其适配进自动策略链，provider 自行通过
`modelState` 序列化和恢复原生 continuation 状态。

### `@may/session`

Session package 把 Core 组合成长生命周期身份。它负责 Session id、metadata、串行
提交、Context 连续性、Session 事件和存储 seam，也提供可复用的内存及文件 Catalog。
它可以依赖 `@may/core`，但 Core 不得依赖它。

### `@may/permissions`

原始工具包含 capability，不包含终端交互。Core 暴露通用 tool-executor seam；权限
package 实现该 seam，用于允许、拒绝或暂停执行并等待审批。策略接收已解析的工具
输入，审批事件构成 headless 协议：TUI 只负责渲染请求并返回决定。

Permission executor 支持一次性决定和生命周期内的显式 scope grant。应用为每个
Session 使用一个 executor，避免 grant 跨 Session 泄露。它的 awaited event sink
使 Session 能在对应工具结果之前持久化审批请求和决定。持久化 grant 是未来存储工作，
不属于 UI。

### `@may/application`

Application package 提供位于 Session 与 Core 之上的 headless 编排。
`AgentApplication` 拥有一个持久化 Session，并集中负责：

- 从注入的模型、工具、Context factory、权限策略、指令和存储创建或恢复 Session；
- 提交、重试、取消、审批处理和安全关闭；
- 转发标准化的 Run 与 permission 事件；
- Context 检查、压缩取消，以及持久化改变后的模型可见 Context；
- 可选安装有界 `session_history`，并保存模型不可见的工具呈现 metadata。

`AgentWorkspace` 增加活动 Session Catalog、自动恢复、创建/恢复/重命名/删除、Catalog
摘要和 FIFO 状态迁移队列。产品可以通过 `transitionApplication` 在同一 Session 上
重建活动 application，或用 `runStateTransition` 串行化产品自有配置操作。

这些 class 提供排序和依赖注入 seam，不定义 provider registry、system prompt、编码
权限策略、model profile、UI 命令或终端渲染。当前 JSONL Session store 和 append-only
文件 Catalog 是轻量本地后端，并不声称具备 crash-proof、多主机生产存储能力。

### `@may/tui`

TUI package 是 May 的终端组件 package，并且有意理解 Agent 概念。它在一个 package
内保留两个层级：

- `Text`、editor、selection、scrolling、overlay、focus、screen buffer、renderer
  和 Node terminal adapter 等终端基础组件；
- `TranscriptStore`、`TranscriptView` 和实例级 `ToolRendererRegistry` 等 Agent 投影。

Agent 层消费 Core、permission 与 Session 事件并构建 retained transcript，通过
`@may/tui/transcript` 和 `@may/tui/tool-renderers` 暴露。产品标签、提示、布局、命令
和 controller 调用仍由应用提供。图形或远程 UI 可忽略 `@may/tui`，直接消费
headless controller。

### `apps/maybecode`

MaybeCode 是应用组合层，不是另一个 runtime。它选择和配置可复用 package，把通用
单 Session 和 workspace 生命周期交给 `@may/application`，使用 `@may/tui` 的 Agent
transcript，并形成终端编码 Agent 产品。任何可复用 package 都不依赖 MaybeCode。

应用只保留产品策略和兼容适配：

- MaybeCode prompt、指令来源策略和 shell runtime 指导；
- 默认编码工具、变更预览生成和编码权限策略；
- 命名手动压缩选项和有序自动压缩链；
- provider/model profile、reasoning effort 覆盖和默认模型持久化；
- slash command、产品事件、主题、页面布局、模型/Session picker flow，以及 classic
  与 retained 两种终端行为。

`MaybeCodeApplication` 现在是 `AgentApplication` 上的产品组合 wrapper。它将通用
工具呈现事件映射为既有 change-preview 事件，同时委托 Run、审批、历史、Context
和关闭操作。`MaybeCodeWorkspace` 同样包装 `AgentWorkspace`，主要保留 model
profile 与 effort 策略。

它明确的产品 UI 边界是 `MaybeCodeController`：用户意图通过方法表达，异步模型、
工具、权限、Context 和 Session 变化形成 `MaybeCodeEvent` stream。
`MaybeCodeWorkspace` 实现该 headless 契约。随项目提供的前端消费此契约，其他 UI
也可复用同一个 controller，而不继承 MaybeCode 渲染或命令策略。
`MaybeCodeTerminal` 只是为了复用 classic frontend 的行式 I/O adapter，并非自定义
UI 的完整边界。

## 事件与持久化

`MayEvent` 是对一个 Run 的 best-effort 实时观察，可能包含 streaming delta。当有界
relay queue 丢弃高频 delta 时，慢消费者可能看到 sequence 缺口；最终结果和持久化
事实不依赖保留每个 delta。

`PermissionEvent` 报告实时审批请求及其处理或取消。`SessionEvent` 记录持久化的
Session 事实，例如提交消息、完整 assistant 消息、审批、工具结果和 Run 边界。
应用也可以记录带 namespace 和 version 的 `tool.presentation` metadata。Session
暴露这些数据，但不会将其回放进模型 Context。UI 状态只是这些事件的投影，从不是
事实来源。

Session package 提供内存存储，以及可选的 Node.js JSONL file-store 入口。Session
可以从持久化历史重建 Core Context；历史模型不依赖终端 UI 或某种特定后端。
