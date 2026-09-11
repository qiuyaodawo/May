# Agent definition、Application 与 Workspace

[English](../../en/concepts/agent-application.md) | **简体中文**

May 将可复用 Agent 配置、对话身份以及当前拥有该对话的进程区分开来。完整 package
边界见 [Runtime 与 Session 边界](../architecture/runtime-session.md)，更精简的生命周期
术语见 [Session、Run 与 Step](session-run-step.md)。这两个组合对象的架构取舍记录在
[ADR 0004](../architecture/decisions/0004-agent-definitions-and-tool-registries.md)。

## `AgentDefinition`：可复用行为与策略

**Agent definition** 是决定 Agent 如何工作的可复用产品配置，通常包括：

- 一个 `Model`；
- 指令；
- 工具，以及可选的自定义 `ToolExecutor` 和 `ToolScheduler`；
- `PermissionPolicy`；
- `ContextFactory`、Context budget 和压缩策略；
- 最大 Step 数、是否暴露 Session history tool 等应用选择。

`@may/application` 导出 `AgentDefinition` class 和便捷函数 `defineAgent()`。Definition
明确排除 Session-bound 的 `store`、`sessionId`、`resume`、`metadata` 和
`contextMetadata`；调用 `definition.open(...)` 时必须提供 store，并按需提供其余输入：

```ts
import { defineAgent } from "@may/application";

const agent = defineAgent({
  model,
  tools,
  instructions,
  permissionPolicy,
});

const application = await agent.open({
  store,
  metadata: { workspace: process.cwd() },
  contextMetadata: { workspace: process.cwd() },
});
```

当 class constructor 更方便时，`new AgentDefinition(options)` 与 `defineAgent(options)`
等价。Definition 本身没有 Session id、对话历史、活动 Run、event stream 或需要关闭的
独立生命周期。同一个 definition 可以多次 `open()`；每次调用都会创建互相独立的
`AgentApplication` 和 Session 生命周期。用 `sessionId` 与 `resume: true` 可以重建已有
Session。

独立的是进程内 lifecycle object，不是同一 durable Session 的 writer lease。Definition、
Application 和内置 store 都不会协调两个以相同 `sessionId` 打开的 application；同一
durable Session 不应被并发打开，应由一个 application 或 workspace owner 独占写入。

创建 definition 时，工具 `Iterable<Tool>` 会立即被消费并按当时内容保存。因此，之后
修改原数组或 `ToolRegistry` 不会改变该 definition。Context budget、自动压缩策略数组和
Session-history option 也会被浅复制并冻结。单个 `Tool` 对象、`Model`、
`ContextFactory`、`ToolExecutor`、`ToolScheduler`、policy closure 和 compaction
strategy 等协作者不会被复制；它们仍由调用方拥有，并会被同一 definition 打开的
多个 application 共享。需要隔离这些对象时，应为每个 definition 构造独立实例。

这一区分在恢复时很重要：`@may/session` 恢复持久化的对话事实，但不会重建模型、
工具、prompt 或权限策略。应用必须再次提供这些组件。Session metadata 可以标识或
校验产品配置，但 May 尚不会版本化或迁移任意 Agent definition。

## `AgentApplication`：一个活动 Session

`AgentApplication` 是恰好一个持久化 `Session` 的可复用 headless 生命周期 owner。
通常由 `AgentDefinition.open()` 创建；需要动态、一次性的全部配置时，也可以直接调用
`AgentApplication.open()`。两条路径最终都把产品配置组合为：

```text
AgentApplication
|- Session
|  `- May runtime
|     |- Model
|     |- Context
|     `- Tools -> ToolScheduler -> PermissionToolExecutor -> optional ToolExecutor
`- application event relay
```

直接调用时，必需输入为 model、`SessionStore` 和 permission policy。使用 definition
时，model 和 permission policy 在定义阶段提供，`SessionStore` 在 `open()` 阶段提供。
工具、指令、Context 配置、Session 身份和其他策略均可选。两条路径都会在构造 Core
runtime 前快照工具 iterable。重要的 ownership 规则包括：

- `metadata` 会复制到新 Session，创建或恢复后可用于校验。
- `contextMetadata` 经 Context 发送给模型请求；未指定时回退为 Session metadata。
- `resume: true` 必须同时提供 `sessionId`。恢复从持久化消息重建 runtime，同时使用
  应用当前提供的配置。
- `sessionHistory` 是 opt-in。启用后应用安装有边界的 `session_history` 工具并保留
  该工具名。
- `createToolPresentation` 可在权限评估前产生应用自有、带版本的显示数据。数据会被
  持久化，但不会加入模型 Context。
- 自定义 Context 可以不暴露管理 controller；此时 Context 检查或压缩不可用，应用
  不会伪造该能力。

该 class 实现与 UI 无关的 `AgentController`，支持提交、重试、取消、审批处理、
历史查询、Context 检查和压缩，以及关闭。事件通道见[事件与持久化](events.md)。

### 活动操作规则

一个 application 同时只允许一个活动 Run 或 Context 压缩。`submit()`、`retry()` 和
`compactContext()` 会拒绝冲突操作。`cancel()` 优先取消活动 Run，否则取消活动压缩，
并返回是否找到可取消操作。

`retry()` 的语义刻意保持狭窄：只有最近的持久化 Run 终态事件为 `run.failed` 时才
接受。它延续已有 Context，不重复记录用户输入。最近 Run 已取消或完成时不能用该方法
重试。

手动压缩产生变化后，会在 `compactContext()` 返回前持久化。自动压缩也会在模型
请求继续前持久化。压缩 checkpoint 为何不删除旧历史，请参阅
[Context 与持久化历史](context-and-history.md)。

## `AgentWorkspace`：选择活动 Application

`AgentWorkspace` 在活动 application 外增加多 Session 导航，但任意时刻仍只拥有
**一个活动 `AgentApplication`**。它需要：

- workspace 标识；
- 保存历史的 `SessionStore`；
- 保存可列出摘要的独立 `SessionCatalog`；
- 产品提供的 `openApplication({ sessionId, resume })` factory。

该 factory 可以直接调用一个共享的 `AgentDefinition.open()`，也可以为每次打开执行
额外的产品逻辑。Workspace 用它打开初始 application，以及每个新建或恢复的 Session。
Workspace 本身不选择 provider、工具、prompt、permission policy 或 model profile。

```ts
openApplication: ({ sessionId, resume }) => agent.open({
  store,
  metadata: { workspace },
  ...(sessionId === undefined ? {} : { sessionId }),
  ...(resume ? { resume: true } : {}),
})
```

打开时显式 `sessionId` 优先。否则，启用 `autoResume` 时，workspace 从 Catalog 查询
该 workspace 最近使用的记录，并且只在 SessionStore 历史非空时恢复。若两者都未
选中历史，产品 factory 创建新 Session。两种情况都会产生初始 `session.changed`
事件，`resumed` 表示使用了哪条路径。

Workspace 提供：

- Session 的列出、创建、恢复、重命名和删除；
- 将 Run、审批、历史和 Context 操作委托给活动 application；
- 打开后及 Run 完成前后的 best-effort summary 更新；
- 可容忍失败的 FIFO Session/产品状态迁移队列；
- 默认保持当前 Session 的 `transitionApplication()`，用于重建产品配置；
- `runStateTransition()`，让产品自有状态变化复用同一排序边界。

Session 切换、删除、重命名、压缩和 application 替换都要求活动 application 处于空闲。
`cancel()` 与审批处理是直接操作，不进入状态迁移队列。

### 产品迁移和 definition 都不是 definition 存储

切换 model profile 是 `transitionApplication()` 的典型用途。产品先创建替换实例；
创建失败时旧 application 仍保持活动。替换实例默认必须暴露相同 `sessionId`。随后旧
application 被关闭，relay 排空后，workspace 才开始转发新实例事件。

这个机制不会自行持久化 Agent definition、model profile 或其他产品状态。产品拥有该
状态，并可在迁移后发出 typed extension event。Definition 是进程内组合对象，不是
序列化 manifest 或 registry entry。同理，`AgentWorkspace` 对 application event、
extension event 和产品定义的 compaction selection type 都使用泛型。

## Catalog 操作是投影，不是事务

Catalog 是用于发现的轻量投影，与持久化 Session history 分离。默认 summary 使用
首条文本输入作为标题、最近一条非空用户或 assistant 文本作为预览，并以已提交输入
数量作为 turn count。

重命名改变 Catalog 记录，不改变 Session event log。删除会分别调用 SessionStore 与
SessionCatalog 的可选删除操作，拒绝删除活动 Session，并且不构成跨 store 事务。
存储和回放影响见
[Context 与持久化历史](context-and-history.md#catalog-与-history)。

## 关闭顺序

Close 是幂等的，但调用方仍应 `await`。正确顺序防止终结事件和持久化被提前截断。

`AgentApplication.close()`：

1. 标记 application 已关闭，阻止新操作启动。
2. 取消活动 Run 并等待结果及其事件 relay。
3. abort 并等待活动 Context 压缩。
4. 关闭 permission executor，按需取消未处理审批。
5. 等待剩余 Run relay 与 permission-event relay。
6. 移除自动压缩 sink。
7. 关闭 application event queue。

`AgentWorkspace.close()` 先停止接受状态迁移并等待已接受的迁移，再关闭活动 application，
等待事件 relay 和待处理 Catalog summary 写入，最后关闭 workspace event queue。

关闭这些编排对象并不意味着它们会调用注入的 model、SessionStore、Catalog 或其他
外部资源的关闭方法；产品仍负责额外资源的生命周期。

## 当前限制

`@may/application` 仍是开发预览 API。目前有一等 `AgentDefinition` 组合对象，但没有
进程级 Agent-definition registry、definition 序列化或迁移、在同一 workspace 对象中
同时活动的多个 Session、多 Agent 委派、分布式锁，也没有 history 与 Catalog 存储
之间的事务协调。

需要在独立 application 之间运行固定流水线、DAG 和并行任务时，使用单独的
[协作层](../guides/coordination.md)。这不会让 workspace 同时拥有多个活动会话，
也不会向 Application 自动加入模型驱动的委派。

协作层还支持显式启用的 Subagent 委派。`submit({ input, inputId })` 会拒绝重复的
持久化输入身份；`shouldYield` 是在完整步骤后检查的可选宿主回调。Yielded Run
返回 `finishReason: "yielded"`，不等于任务完成或取消。等待与后续提交由调用方
负责，`retry()` 不重试 yielded Run。不使用这些选项的普通提交保持原有行为。
