# Package 参考

[English](../../en/reference/packages.md) | **简体中文**

通过本页查找 package、公开导入路径和相关配置指南。可复用框架代码位于
`packages/`，可执行产品位于 `apps/`。应用依赖 package，package 的导入保持在
可复用代码范围内。

当前 checkout 中的 package 版本均为 `0.1.0`。仓库要求 Node.js `>=22.16.0` 和
pnpm `12.4.2`。公开 API 和持久化格式的稳定性见
[兼容性与稳定性](compatibility.md)。本页列出的导入路径属于 package exports；
安装和发布范围由仓库的发布配置管理。

## 根据任务选择 package

| 目标 | 使用入口 | 通常需要补充 |
| --- | --- | --- |
| 在内存中运行模型与工具循环 | `@may/core` | Provider adapter |
| 定义可复用的 Agent 行为与策略 | `@may/application` 的 `defineAgent()` | `@may/core` 的 `ToolRegistry` |
| 构建持久化单 Session Agent | `AgentDefinition.open()` 或 `AgentApplication.open()` | `@may/session`、`@may/context`、权限和工具 |
| 管理多个 Session | `@may/application` 的 `AgentWorkspace` | `@may/session/catalog` 的 `SessionCatalog` |
| 协调团队和远程 Worker | `@may/coordination` | Agent definition、持久化存储和宿主策略 |
| 持续执行持久化目标 | `@may/goal` | 宿主 Agent 和有界 continuation 策略 |
| 根据时间或事件触发任务 | `@may/scheduler` | SQLite 存储和幂等 dispatcher |
| 评估不同配置的任务结果 | `@may/eval` | Execution adapter、隔离环境、evaluator 和报告 |
| 通过生命周期 Hook 扩展应用 | `@may/plugin` | `@may/plugin-services` 和可复用插件 |
| 构建终端 Agent | Application controller | `@may/tui`，可选 `@may/keybindings` |
| 构建浏览器 Agent | `UiHost` 或 `ApplicationUiHost` | `@may/ui-client` 和 `@may/web-ui` |
| 构建编码 Agent | Application controller | `@may/coding-tools` 和执行隔离策略 |
| 根据配置选择模型 | `@may/config` | `@may/providers` |
| 通过工具读取持久化历史 | `@may/session-tools` | 活动 `Session` 或 `AgentApplication` |
| 校验并保存图片回复 | `@may/media` | 读取 URL 或文件来源的宿主 `MediaReader` |
| 追踪执行过程和查看诊断 | Core 的 `Tracer` 接口 | `@may/observability` |
| 使用或导出 MCP 能力 | `@may/mcp` | 权限和经过审查的宿主服务 |

包含 Session、审批、Context 管理和关闭资源的完整应用流程见
[构建 Agent](../guides/building-an-agent.md)。

## Runtime 与 Application

### `@may/core`

与 provider 无关的执行内核，导出 `May`、`Model`、`Tool`、`Context`、
`ToolExecutor`、`ToolScheduler` 和 `InMemoryContext`。它执行模型与工具 Step、
传递流式事件、调度工具并传播取消信号。存储、provider 选择、应用配置、权限策略
和 UI 由宿主应用提供。

`ToolRegistry` 实现 `Iterable<Tool>`，提供 `register()`、原子 `registerAll()`、
`has()`、`get()`、`require()`、`size`、`names()`、`values()`、`definitions()`、
`clone()`、迭代和静态 `compose()`。有歧义的名称会抛出
`DuplicateToolNameError`。Registry 保留原始 Tool 身份，并检查注册后的 descriptor
数值和引用是否被替换；注册阶段保留 schema 引用，不进行深度冻结。

`May` 在构造时保存 iterable 成员快照。每次 Run 使用 `ToolRegistry.snapshot()`
冻结复制后的 descriptor 和 schema，并捕获回调。可选的追加式 `toolSource`
在每次 Run/continue 时解析一次；授权绑定工具定义和宿主版本。参阅
[自定义工具](../guides/custom-tool.md)和 [Core README](../../../packages/core/README.md)。

### `@may/application`

Core 之上的 headless 编排层，导出：

- `AgentDefinition` 和 `defineAgent()`：定义可复用行为与策略；
- `AgentApplication`：管理一个活动的持久化 Session；
- `AgentWorkspace`：管理活动 Session 选择和 Catalog 更新；
- `AgentController` 和 `AgentWorkspaceController`：提供与 UI 无关的控制接口；
- `AsyncStateSerializer`：串行执行应用与 Session 状态迁移。

Definition 创建时保存工具 iterable 成员快照。每次 `open({ store, ... })` 创建
独立的 application/Session 生命周期，宿主提供存储、身份和 metadata。Definition
引用的 Model、Context factory、executor 和 scheduler 仍由调用方拥有；多次打开
应用会复用这些对象。Session 保存 Context 检查和压缩结果。应用可以安装
`session_history` 和工具呈现支持。

`AgentWorkspace` 与 `AgentWorkspace.open` 使用泛型参数顺序
`<Event, Extension, Compaction, Run, Application>`。
`@may/application/git-workspace` 导出 `ProjectGitWorkspace` 及 checkpoint、diff、
restore 和 worktree 类型，用于宿主控制的 Git 操作。参阅
[Agent 与 Application](../concepts/agent-application.md)和
[Application README](../../../packages/application/README.md)。

### `@may/coordination`

`CoordinationRuntime` 在单个 coordinator 管理下执行宿主定义的 DAG。
`pipeline()` 和 `parallelTasks()` 生成相同的任务图结构。
`createApplicationAgent()` 为每个任务执行方打开独立 Session，路由审批请求，
支持单 Run 预算和基于证据的恢复。`onOpen` 在首次提交输入之前绑定 Session
专用辅助对象。

`createAttachedApplicationAgent()` 将宿主持有的 application 绑定到任务。宿主
提供 Session 所有权和每轮 submit 选项；adapter 管理输入身份、安全 yield 和
取消信号，拒绝第二次并发认领，application 的打开和关闭由宿主负责。
`CreateCoordinationOptions.sessionIds` 将根任务绑定到现有 Session。
`TaskSpec.files` 声明任务可以修改的工作区相对文件。

可选能力需要宿主显式授权：

- `delegate_tasks`：创建嵌套任务、安全 yield 和带身份的唤醒轮次，受任务数量、
  深度和轮次限制；
- `send_message` / `wait_for_messages`：有界持久化平级消息和每轮收件箱；
- `handoff_task`：通过明确的上下文摘要和持久化执行方历史，将逻辑任务转交给
  新 Agent Session；
- `retryTask()`：宿主创建新的 Attempt；
- `rewriteGraph()`：宿主原子修改尚未提交的后续节点。

委派、消息和移交策略默认拒绝。恢复过程核实未知副作用，然后才继续安排任务。
Runtime 尚未启动且没有活动执行时，`resolveRecovery()` 也接受 queued 和 waiting
任务。

| 导入路径 | 用途 |
| --- | --- |
| `@may/coordination` | Runtime、任务图构造、Agent adapter、策略和资源接口 |
| `@may/coordination/file-store` | `FileCoordinationStore` 本地单写入者协作日志 |
| `@may/coordination/remote` | 远程叶子 Worker、持久化回执和鉴权传输 |

主入口 `@may/coordination` 导出的 `FileSharedBudget` 管理共享用量预留，
`FileArtifactStore` 保存不可变且限定作用域的文本产物。
`TaskWorkspaceManager` 管理隔离文件副本；应用副本修改需要宿主操作。这些资源
使用本地所有权和日志。远程 Worker 保存各自的回执，单个 coordinator 管理调度；
当前传输没有高可用或多写入者故障切换。

参阅[任务图](../guides/coordination.md)、[共享资源](../guides/coordination-resources.md)、
[Attempt 与任务图修订](../guides/coordination-lifecycle.md)、
[远程 Worker](../guides/coordination-remote.md)和
[MaybeCode 团队](../guides/maybecode-team.md)。

### `@may/goal`

持久化目标状态、有界 continuation 和模型可见目标工具通过公开的 Agent、Model
和 Context 接口组合。宿主提供执行能力和 continuation 策略。参阅
[目标执行](../guides/goals.md)。

### `@may/scheduler`

持久化调度支持一次性时间、包含 timezone 的五字段 cron、宿主发布事件、原子
事件去重和重启后的可靠提交。宿主调用 `start()` 或 `tick()`，管理 Agent 执行、
权限、并发和结果投递。`@may/scheduler/sqlite-store` 导出独占 SQLite 存储。
Dispatcher 幂等性、misfire 策略和恢复见[调度指南](../guides/scheduler.md)。

### `@may/eval`

`EvalRunner` 校验并将带版本的 Case 和 Variant 展开为 Trial，在隔离环境中执行，
调用独立 evaluator 并生成持久化 Report。Runtime outcome 和 task verdict
分别记录在报告字段中。

| 导入路径 | 用途 |
| --- | --- |
| `@may/eval` | 类型、registry、校验、runner、环境、evaluator、报告、命令和 telemetry |
| `@may/eval/application` | `createApplicationExecutionAdapter()`，使用全新 application Session |
| `@may/eval/coordination` | `createCoordinationExecutionAdapter()` 和 `EvalTrialBudget`，使用全新任务图 |
| `@may/eval/file-store` | `FileEvalStore`，独占本地实验存储 |

Adapter 需要版本、全新执行资源和已绑定的 Trial 预算。Suite module 和命令
evaluator 执行可信宿主代码。取消和重启保留未知副作用证据，供宿主核实恢复。
参阅[评估 Agent 任务结果](../guides/eval.md)。

### `@may/plugin`

限定 scope 的插件宿主提供带类型和版本的 service、依赖校验、配置 schema、
状态迁移、有序生命周期 Hook、资源清理和串行组合修改。Application 将插件与
Agent definition、runtime factory 和持久化 Session 集成。参阅
[插件、Service 与生命周期 Hook](../guides/plugins.md)。

### `@may/plugin-services` 与可复用插件

共享 service token 和有序 registry 描述 Tool、instruction、Model 和 Context
贡献。Application 通过 `applicationServices` 重新导出 token，并通过 plugin
factory 组合直接传入的配置。

`packages/plugins/` 中的 15 个可复用 `@may/plugin-*` package 及其 factory API
列在[插件 package 目录](../guides/plugins.md#可复用插件-package)。
`@may/plugin-agent-adapters/rpc` 和
`@may/plugin-agent-adapters/examples/rpc-file-agent` 分别提供 RPC adapter 和示例。
产品插件组合位于各应用的 `src/plugins/`。`pnpm test:package:plugin` 验证独立安装
的 tarball 及其完整运行时依赖。

### `@may/skills`

提供 Agent Skills 发现、解析、有界资源读取和 Session 激活。Application 将
Skills 与持久化状态和动态 Context 指令组合。参阅[Agent Skills](../guides/skills.md)。

### `@may/observability`

Tracing 和诊断实现 Core 的可选 `Tracer` 接口。导出包括 `BasicTracer`、确定性
采样、不可变完成 span、内存及串行有界 processor，以及内存、JSON console 和
本地 JSONL exporter。`OpenTelemetryTracer`、`OpenTelemetryMetricRecorder` 和
`createOtlpTelemetry()` 接入外部 telemetry。`DiagnosticsStore` 和 `TaskAssessment`
提供应用诊断及任务评估。

Core、Application、Session、Model 和工具 context 显式传播 trace identity。
宿主管理 processor 生命周期和资源清理。参阅
[可观测性与 Tracing](../guides/observability.md)。

### `@may/mcp`

Client pool 连接配置的 stdio 或 Streamable HTTP 端点，协商 MCP，并将发现的
工具转换为 Core `Tool`。模型可见名称带 namespace 并检查冲突。调用传播取消、
progress 和可选注入 tracing。打开 pool 的应用必须关闭 pool 及其拥有的进程。
Server 状态、生命周期事件和有界、经过净化的 stderr 支持诊断。

`catalog()` 返回带版本的 metadata。`refresh()` 和 `reconnect()` 更新 pool；
`toolSource: () => pool.tools` 为每次 Run 绑定不可变工具集合。宿主控制的
resource/template、prompt、completion 和 watch 使用有界内容及显式附件。
其他导出包括：

- `McpInteractionBroker`：显式启用的有界 form/URL 交互、有归属的现代 MRTR
  continuation、取消和过期；
- `McpHostServices` 和端点 `host` 开关：经过审查的 Roots/Sampling；
  `createMcpModelSampler()` 执行隔离、有界 provider 调用，关闭工具执行，并且
  无法读取 Session Context；
- `McpTaskJournal`、`parseMcpTask`、`mcpTaskToUserMessage` 和 pool task API：
  显式启用的现代 Task、持久化所有权和显式结果附件；
- `pool.openApp`、`mcpAppSandboxResponse` 和 `@may/mcp/apps-browser`：浏览器
  App，要求用户同意并限制 origin 和 CSP；
- `@may/mcp/server`：`createMayMcpServer()`，具有鉴权、授权和明确公开结果投影
  的 tool/resource/prompt 导出。

原生 OAuth 和基于 OS keyring 的加密凭据 vault 为可选能力。旧协议交互要求
显式使用单操作进程或 Session。Server 导出由宿主启动监听并选择公开能力。
参阅 [MCP 工具](../guides/mcp.md)、[认证](../guides/mcp-auth.md)、
[Task](../guides/mcp-tasks.md)、[App](../guides/mcp-apps.md)和
[Server 编写](../guides/mcp-server.md)。

## 状态与策略

### `@may/context`

可替换的 Context factory 和压缩策略包含内存托管 Context、检查、自动压缩、
summary-tail、history-reference 和裁剪。`@may/context/model-summarizer` 提供
模型摘要能力。Context 保存当前模型可见内容，Session 保留持久化历史。参阅
[Context 与持久化历史](../concepts/context-and-history.md)。

### `@may/session`

持久化对话身份和事实包括串行提交、continuation、事件历史、基于 cursor 的
查询、内存存储和 `Session.fork()` 分支。`@may/session/file-store` 提供 JSONL
存储，`@may/session/catalog` 提供内存和文件 Catalog。Catalog 发现 Session，
Session Store 读取并追加单个 Session 的记录。参阅
[配置 Session 存储](../guides/custom-storage.md)和
[Session、Run 与 Step](../concepts/session-run-step.md)。

### `@may/permissions`

Headless `ToolExecutor` 评估 `PermissionPolicy`、发布审批请求并接受允许或拒绝
决定。Session grant 在配置的 executor 生命周期内有效。`PermissionRuleStore`、
`PersistentPermissionRule` 和 `InMemoryPermissionRuleStore` 支持持久化审批规则；
`@may/permissions/file-store` 导出 `FilePermissionRuleStore`。宿主提供审批 UI 和
需要的执行隔离。作用域、过期和撤销见[权限策略](../guides/permission-policy.md)。

### `@may/config`

加载并校验 provider 连接、model profile 和应用自有配置。`@may/config/schema`
导出 JSON Schema。Runtime 的 `apps` 值为通用结构；内置编辑器 schema 另外描述
MaybeCode 配置。第三方应用自行校验它们的应用配置区段。参阅
[配置参考](configuration.md)。

## 模型与 Provider

### `@may/providers`

`ProviderAdapterRegistry` 提供实例级内置 adapter 注册、配置模型选择和 capability
解析。各协议实现也可以单独使用：

| Package | 协议 |
| --- | --- |
| `@may/provider-openai` | OpenAI Responses API 和原生压缩 |
| `@may/provider-openai-compatible` | Chat Completions 兼容协议的共享能力 |
| `@may/provider-anthropic` | Anthropic Messages API |
| `@may/provider-deepseek` | DeepSeek Chat |
| `@may/provider-zhipu` | 智谱 GLM Chat |
| `@may/provider-kimi` | Kimi Chat |

`@may/provider-openai-compatible/http` 导出 `readSseData` 和 `parseRetryAfterMs`。
SSE 解码使用 `eventsource-parser`，支持 LF、CRLF 和 CR，并接受 EOF 之前没有
空白行的最后一个事件。中止或提前结束迭代会释放响应 body。Retry-After 支持
秒数，包括小数，以及 HTTP 日期；返回毫秒数，缺失或无法识别时返回 `undefined`。

Chat Completions chunk 中的顶层 `error` 会立即使流失败。可读的 server
`message`、`type` 和 `code` 保留在错误消息中；无法读取的 error 结构产生明确
诊断。失败流不发送 `response.completed`，后续 `[DONE]` 或 `finish_reason`
保持失败状态。参阅[自定义 Model](../guides/custom-model.md)和
[Provider 兼容性](compatibility.md)。

## 工具与媒体

### `@may/coding-tools`

限定 workspace 的 read、edit、write 和 shell 工具支持编码应用。Read、edit 和
write 接受宿主提供的路径锁 `guard`，用于并发 executor。
`@may/coding-tools/instructions` 导出指令加载，
`@may/coding-tools/change-preview` 导出编码变更预览。

`codingRuntimeInstructions()` 生成 workspace、操作系统、shell、Agent 角色、
Session 来源和权限字段。`shellRuntimeInstructions()` 提供 shell 语法指导。
项目指令包含绝对来源路径。参阅
[MaybeCode 指令组合](../guides/maybecode-instructions.md)。

Shell 命令以宿主进程权限执行。PowerShell 最后一条命令成功时返回
`exitCode: 0`；最后一条命令失败时保留最近的非零 native 退出状态，无法获得时
返回 `1`。`exit N` 返回 `N`。后续命令成功时，之前的 non-terminating error
仍保留在 `stderr` 中。权限和隔离要求见[自定义工具](../guides/custom-tool.md)。

### `@may/session-tools`

有界、只读 `session_history` 工具查询持久化 Session 历史。
`AgentApplication` 可以自动安装，底层宿主也可以直接构造。

### `@may/media`

`imageAttachment()` 生成附件 metadata。`displayParts()` 投影文本和图片，并省略
reasoning 内容。`inspectImage()` 校验 PNG、JPEG、WebP、GIF 和 AVIF，限制为
32 MiB 和 4000 万输入像素。`readEmbeddedImage` 校验 base64 内容和 MIME 一致性；
URL 和 file-ID 来源的字节需要宿主提供 `MediaReader`。

`FileMediaStore` 校验并保存图片、验证已保存文件，默认使用 `readEmbeddedImage`。
`imagePng()` 将已校验图片转换为 PNG。终端、Web UI 和渠道集成见
[图片回复](../guides/images.md)。

## UI

### `@may/tui`

终端组件和 Agent 感知投影使用以下导入路径：

| 导出 | 用途 |
| --- | --- |
| `@may/tui` | 组件、renderer、editor、focus、scroll 和 terminal driver |
| `@may/tui/node-terminal` | 面向行的 Node terminal adapter |
| `@may/tui/transcript` | Session/live-event transcript store 和 retained view |
| `@may/tui/tool-renderers` | 实例级工具呈现 renderer |
| `@may/tui/slash-commands` | 命令解析和补全状态 |
| `@may/tui/list-selection` | 带过滤的列表和选择器状态 |

宿主应用定义产品命令、标签、布局和 controller 调用。参阅
[自定义 UI](../guides/custom-ui.md)。

### `@may/ui-client` / `@may/web-ui`

`@may/ui-client` 导出与 UI 无关的 client 协议。`/application`、`/reading`、
`/projection` 和 `/server` 子路径提供 application adapter、阅读状态、投影和
server 支持。`@may/web-ui` 提供浏览器 workbench 组件，`/styles.css` 和 `/assets`
导出样式与资源支持。产品 adapter 保留各自的 Session/task 语义。参阅
[Web UI 指南](../guides/web-ui.md)、
[UI client README](../../../packages/ui/client/README.md)和
[Web UI README](../../../packages/ui/web/README.md)。

### `@may/keybindings`

将特定 context 的按键序列映射为语义化 UI action。宿主管理终端渲染和产品命令。

## 参考产品

本节所有应用均为 workspace 私有 package。

| Package | 用途 | 指南 |
| --- | --- | --- |
| `@may/maybecode` | 编码 Agent、终端/Web UI 宿主、子 Agent 委派和经过审查的团队流程 | [MaybeCode](../guides/maybecode.md) |
| `@may/maybeclaw` | 管理持久化对话、Agent adapter、事件路由和渠道投递的 Gateway | [MaybeClaw](../guides/maybeclaw.md) |
| `@may/cli` | 展示直接使用 Core 的小型应用 | [快速开始](../getting-started.md) |
| `@may/eval-cli` | 可信 suite 评估命令、报告、恢复和比较 | [评估](../guides/eval.md) |

MaybeCode 团队使用本地 Agent，默认只读。Coding mode 修改私有副本，宿主审查
并将补丁应用到源文件。配置的检查需要独立授权，以宿主进程权限执行。参阅
[团队编码](../guides/maybecode-team-coding.md)。

MaybeClaw 的 `AgentGateway` 组合 `PluginHost`、Agent adapter、coordination 和
delivery service。CLI、经过鉴权的 Web UI/control API 和飞书/Telegram adapter
操作持久化 Gateway conversation。私有 `@may/maybeclaw/rpc` 导出提供 RPC
宿主集成。
