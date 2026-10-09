# 事件与持久化

[English](../../en/concepts/events.md) | **简体中文**

应用通过实时事件展示进度，通过持久化事件恢复对话。本文说明事件由哪个组件产生、
何时保存，以及消费者如何处理未完整接收的增量内容。

生命周期边界见 [Session、Run 与 Step](session-run-step.md)，回放见
[Context 与持久化历史](context-and-history.md)，整体包结构见
[Runtime 与 Session 边界](../architecture/runtime-session.md)。

## 事件层

### `ModelEvent`

模型适配器为每次请求产生与 Provider 无关的 `ModelEvent`：文本和推理增量、
重试通知，以及恰好一个完整响应。这些值不包含 Session 身份。Core 校验响应完成
协议，再把它们转换成 Run 事件。

### `MayEvent`

`MayEvent` 是一个 Run 的实时观察流。每个事件都有 `runId`、Run 内单调递增的 `seq`
和时间戳，覆盖：

- Run 与 Step 开始/完成；
- 模型开始、增量、重试通知和完整消息；
- 工具开始、输出增量、进度、完成与失败；
- Run 完成、交还控制、失败或取消。

`model.completed` 包含完整助手消息，因此正确性不依赖此前每个增量事件都被
保留。工具结束事件同样包含最终输出或序列化错误。
成功工具事件的 `output` 为宿主保留原始输出，`content` 保存模型可见内容并用于
持久化恢复；模型历史工具提供已保存的 `content`。

### `PermissionEvent`

`PermissionToolExecutor` 提供实时审批请求、决定和取消事件。
`AgentApplication` 将其转发为 `{ type: "permission.event", event }`。审批事件的
Session 接收函数等待存储完成，按正确顺序记录持久化审批事实。

### `SessionEvent`

`SessionEvent` 是持久化、按 Session 排序的日志。每个事件都有 `sessionId`、连续
`seq` 和时间戳。Session 只映射回放、历史或审计需要的事实：

- Session 创建和输入提交；
- Run 开始与终结边界；
- 完整助手消息和工具结果；
- 审批请求、决定与取消；
- Context 压缩检查点；
- 带版本的应用工具显示信息。

它省略 Step 生命周期、模型开始与重试、工具开始、流式输出和临时
进度。Session 历史用于保存对话，可观测性组件记录执行追踪。

### `AgentApplicationEvent`

与 UI 无关的应用事件流包装实时 Core 事件与权限事件，并增加应用事实：

```ts
type ApplicationEventShape =
  | { type: "run.event"; event: MayEvent }
  | { type: "permission.event"; event: PermissionEvent }
  | { type: "tool.presentation"; presentation: SessionToolPresentation }
  | { type: "context.compacted"; /* 自动压缩成功；省略结果字段。 */ }
  | { type: "context.compaction.failed"; /* 自动压缩失败；省略错误字段。 */ };
```

该片段展示事件分类；完整字段通过 `@may/application` 导出的 `AgentApplicationEvent` 查询。

工具显示信息会在应用事件发出前、权限策略开始评估前完成
持久化。成功自动压缩也会先持久化，再发出事件并继续模型调用。手动压缩向调用方返回
结果并持久化发生变化的替换，目前不发出相同的应用成功事件。

### `AgentWorkspaceEvent`

Workspace 按序转发活动应用事件，并增加 `session.changed`。产品可以用具有类型的
扩展事件增加联合类型成员，例如模型配置切换后的事件。
`session.changed` 描述活动应用的选择，本身不会追加到 Session 历史。

## 宿主控制的执行暂停

宿主提供 `shouldYield` 时，完整模型与工具 Step 可以通过 `run.yielded` 结束，
结果包含 `finishReason: "yielded"`。全部工具结果确定后才保存相应检查点，
后续工作由宿主安排。Session 保存该事件一次，恢复时保留这个结束状态。
可选的 `input.submitted.inputId` 标识宿主投递，模型可见消息不包含该标识。

## 先持久化、后观察的保证

Session 观察 Core Run 事件流，并逐个映射持久化事件。每个被映射的事件都会先等待
`SessionStore.append()`，再通过 Session 包装的 Run 事件流转发 `MayEvent`。因此，
当应用观察到已映射的完整或终结事件后，只要对应存储操作成功，就可以查询
到对应持久化事实。

其他重要顺序点：

- 普通 `input.submitted` 在 Core 启动 Run 前完成写入；
- 审批请求在对应助手消息已持久化后、相关工具结果前记录；
- 审批决定与取消排在对应请求之后；
- 自动压缩在 Step 开始后、模型快照生成前记录；
- Application 和 Workspace 关闭会先等待事件转发，再关闭队列。

Session 存储失败时取消底层 Run，并使包装后的 Run `result` 拒绝，停止后续执行。

`AgentWorkspace` 会尝试更新 Catalog 摘要，多数写入失败不会阻止对话执行。
Catalog 状态不能替代 Session 历史的顺序保证。

<a id="背压与可丢弃-streaming-event"></a>

## 背压与可丢弃流式事件

Core、Session、AgentApplication 与 AgentWorkspace 使用有界事件转发队列，默认目标为
1024 个缓冲值。下列 `MayEvent` 属于增量事件，消费者处理速度不足时可能丢弃：

- `model.text.delta`；
- `model.reasoning.delta`；
- `tool.output.delta`；
- `tool.progress`。

队列不会主动丢弃不可丢弃的生命周期或终结事件。目标已满时，它先删除已缓冲的
可丢弃事件；如果不存在，就丢弃新的可丢弃事件。新的不可丢弃事件会
保留，即使队列暂时超过目标。

对消费者的影响：

- 压力下实时 Run 的 `seq` 出现缺口是预期行为，不代表缺少持久化事实；
- 增量内容适合响应式展示，精确对话记录应使用完整消息；
- 完整助手消息和工具结束事件应校正任何部分 UI 状态；
- 持久化历史与 UI 是否消费每个实时值无关。

`AgentWorkspaceOptions.isDroppableEvent` 可为产品事件联合类型替换默认分类。自定义
判断函数应保留所有无法重建的事件；把终结事件或产品状态迁移标记为可丢弃会
削弱默认保证。

`AsyncEventQueue` 将消息分配给消费者，多个迭代器会竞争获取消息。每位订阅者需要
完整事件时，应建立独立队列。之后接入的消费者只能读取仍在缓冲区的值和后续值；
历史事实从 Session 历史读取。

## 实时事件不会自动持久化

新增 `MayEvent` 或产品扩展事件不会自动使其持久化。持久化需要明确的 Session
事件结构，以及等待存储完成的记录流程。应用显示数据应使用应用自有、带命名空间的
`kind` 与解码器。Session 校验非空 `kind` 和正整数 `version`，把 `data` 视为
不透明内容，绝不注入 Context。

根据消费者需要选择信息位置：

| 信息 | 保存位置 |
| --- | --- |
| 动画和进度 | 实时事件 |
| 恢复需要的对话事实 | Session 事件 |
| Session 发现 | Catalog 投影 |
| 模型可见状态 | Context，替换时保存持久化检查点 |

<a id="关闭与-stream-结束"></a>

## 关闭与事件流结束

Application 或 Workspace 事件流在所属组件关闭队列后结束。正确关闭会先取消
活动工作，等待 Run 与权限事件转发，再关闭应用队列。Workspace 会先
等待应用事件转发和待处理 Catalog 摘要。Run 自己的事件流在该 Run
结束时自动关闭。

调用方应等待 `close()` 并让 `for await` 消费者结束，取消请求后仍需等待清理完成。
精确生命周期顺序见
[Agent definition、Application 与 Workspace](agent-application.md#关闭顺序)。

迭代器 `return()` 会释放自己的等待项，生产者和其他迭代器继续工作。
Coordination 和 MCP 消费者依据持久状态与历史恢复。
