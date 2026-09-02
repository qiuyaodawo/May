# 事件与持久化

[English](../../en/concepts/events.md) | **简体中文**

May 具有多个事件层，因为模型 streaming、实时 application 状态和持久化 Session
回放的要求不同。它们相关，但不能互换。

生命周期边界见 [Session、Run 与 Step](session-run-step.md)，回放见
[Context 与持久化历史](context-and-history.md)，整体 package 设计见
[Runtime 与 Session 边界](../architecture/runtime-session.md)。

## 事件层

### `ModelEvent`

Model adapter 对一次请求产生 provider-neutral `ModelEvent`：文本和 reasoning delta、
retry notice，以及恰好一个完整响应。这些值不包含 Session 身份。Core 校验 completion
协议，再把它们转换成 Run event。

### `MayEvent`

`MayEvent` 是一个 Run 的实时观察流。每个事件都有 `runId`、Run 内单调递增的 `seq`
和 timestamp，覆盖：

- Run 与 Step 开始/完成；
- model start、delta、retry notice 和完整消息；
- tool start、output delta、progress、完成与失败；
- Run 完成、失败或取消。

`model.completed` 包含完整 assistant message，因此正确性不依赖此前每个 delta 都被
保留。Tool terminal event 同样包含最终输出或序列化错误。

### `PermissionEvent`

`PermissionToolExecutor` 暴露实时 approval request、resolution 和 cancellation 事件。
`AgentApplication` 将其转发为 `{ type: "permission.event", event }`。它的 awaited
Session sink 按正确顺序记录对应持久化审批事实。

### `SessionEvent`

`SessionEvent` 是持久化、按 Session 排序的 log。每个事件都有 `sessionId`、连续
`seq` 和 timestamp。Session 只映射回放、历史或审计需要的事实：

- Session 创建和 input 提交；
- Run 开始与终结边界；
- 完整 assistant 消息和工具 outcome；
- approval request、decision 与 cancellation；
- Context 压缩 checkpoint；
- 带版本的应用 tool presentation。

它有意忽略 Step 生命周期、model start/retry、tool start、streaming output 和临时
progress。因此 Session history 是持久化对话 log，不是完整 telemetry trace。

### `AgentApplicationEvent`

Headless application stream 包装实时 Core 与 permission event，并增加应用事实：

```ts
type AgentApplicationEvent =
  | { type: "run.event"; event: MayEvent }
  | { type: "permission.event"; event: PermissionEvent }
  | { type: "tool.presentation"; presentation: SessionToolPresentation }
  | { type: "context.compacted"; /* automatic success */ }
  | { type: "context.compaction.failed"; /* automatic failure */ };
```

Tool presentation 会在 application event 发出前、permission policy 开始评估前完成
持久化。成功自动压缩也会先持久化，再发事件并继续模型调用。手动压缩向调用方返回
结果并持久化发生变化的替换，但目前不发出相同的 application success event。

### `AgentWorkspaceEvent`

Workspace 按序转发活动 application event，并增加 `session.changed`。产品可以用 typed
extension event 扩展 union，例如 model-profile transition 后的事件。
`session.changed` 描述活动 application 选择，本身不会追加到 Session history。

## 先持久化、后观察的保证

Session 观察 Core Run stream，并逐个映射持久化事件。每个被映射的事件都会先等待
`SessionStore.append()`，再通过 Session 包装的 Run stream 转发 `MayEvent`。因此，
当应用观察到已映射的完整或终结事件后，只要同一个 store operation 成功，就可以查询
到对应持久化事实。

其他重要顺序点：

- 普通 `input.submitted` 在 Core 启动 Run 前 commit；
- approval request 在对应 assistant message 已持久化后、相关工具 outcome 前记录；
- approval resolution/cancellation 排在其 request 之后；
- 自动压缩在 Step 开始后、模型 snapshot 继续前记录；
- application 和 workspace 关闭会先等待 relay，再关闭 queue。

Session store failure 不是无害的日志失败。Session 会取消底层 Run 并 reject 包装后的
Run result，而不会让 history 与 Context 在不一致状态下继续。

Catalog summary update 不同：`AgentWorkspace` 将其中许多写入视为 best-effort 投影。
Catalog state 不能替代 Session history 的顺序保证。

## 背压与可丢弃 Streaming Event

Core、Session、AgentApplication 与 AgentWorkspace 使用有界 relay queue，默认目标为
1024 个 buffered value。下列 `MayEvent` 被归类为 streaming，消费者落后时可能丢弃：

- `model.text.delta`；
- `model.reasoning.delta`；
- `tool.output.delta`；
- `tool.progress`。

Queue 不会主动丢弃 non-droppable 生命周期或终结事件。目标已满时，它先删除已缓冲的
droppable event；如果不存在，就丢弃新 droppable event。新 non-droppable event 会
保留，即使队列暂时超过目标。

对消费者的影响：

- 压力下实时 Run 的 `seq` 出现缺口是预期行为，不代表缺少持久化事实；
- delta 适合响应式展示，不适合精确 transcript 存储；
- 完整 assistant message 和 tool terminal event 应校正任何部分 UI 状态；
- 持久化 history 与 UI 是否消费每个实时值无关。

`AgentWorkspaceOptions.isDroppableEvent` 可为产品 event union 替换默认分类。自定义
predicate 应保留所有无法重建的事件；把终结事件或产品状态迁移标记为 droppable 会
削弱默认保证。

当前 `AsyncEventQueue` 是 queue，而不是可回放 broadcast bus。多个独立 reader 都需
收到每个值时，应建立一个 owner relay 或显式 fan-out。迟到消费者只能读到仍在 buffer
中的值和未来值；历史事实必须从 Session history 读取。

## 实时事件不会自动持久化

新增 `MayEvent` 或产品 extension event 不会自动使其持久化。持久化需要显式 Session
event schema 和 awaited record path。应用显示数据应使用应用自有、带 namespace 的
`kind` 与 decoder。Session 校验非空 `kind` 和正整数 `version`，但把 `data` 视为
不透明内容，绝不注入 Context。

扩展 May 时使用以下规则：

```text
animation/progress -> live event
conversation/replay fact -> Session event
fast discovery -> Catalog projection
model-visible state -> Context (plus a durable checkpoint when replaced)
```

## 关闭与 Stream 结束

Application 或 workspace event stream 在 owner 关闭 queue 后结束。正确关闭会先取消
活动工作，等待 Run 与 permission relay，再关闭 application queue。Workspace 会先
等待 application relay 和待处理 Catalog summary。Run 自己的 stream 则在该 Run
settle 时自动关闭。

调用方应等待 `close()` 并让 `for await` consumer 结束，不要在请求取消后立即放弃它。
精确生命周期顺序见
[Agent definition、Application 与 Workspace](agent-application.md#关闭顺序)。
