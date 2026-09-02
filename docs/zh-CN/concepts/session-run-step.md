# Session、Run 与 Step

[English](../../en/concepts/session-run-step.md) | **简体中文**

May 的执行术语分为四层：

```text
Agent definition -> Session -> Run -> Step
```

Agent definition 是可复用配置，不是当前运行时对象。`AgentApplication` 与
`AgentWorkspace` 编排其他层级；参阅
[Agent definition、Application 与 Workspace](agent-application.md)。Package ownership
视角见 [Runtime 与 Session 边界](../architecture/runtime-session.md)。

## Session

**Session** 是长生命周期的对话身份。它具有稳定 id、可选创建 metadata、单调递增的
事件历史和已配置的 `May` runtime。它可以比任意一次 Run 存活更久，也可以用新构造的
runtime 恢复。

`Session.create()` 需要 runtime，未提供 `SessionStore` 时使用内存 store。它拒绝在
非空历史上创建，并先追加 `session.created`。`Session.resume()` 要求历史存在且有效，
第一条也是唯一一条创建事件必须为 `session.created`。它回放模型可见消息，让调用方
重新创建 runtime，并从最后一个已保存事件之后继续 Session sequence。

Session metadata 是创建 metadata，不是可变 Agent 配置。恢复会返回它，但调用方仍
负责当前模型、工具、指令、权限和 Context 实现。

### 提交串行化

`Session.submit()` 在前一个 Run 之后排队。返回的 Promise 在新 Run 启动时 resolve，
而不是等 Run 完成。某个被拒绝或失败的 Run 不会污染后续提交队列。

普通提交会先持久化 `input.submitted`，再让 Core 把用户消息追加到 Context。若取消
发生在 store write 期间，Session 会先启动 Core 再转发取消，使持久化回放和实时
Context 位于同一输入 commit 边界。提交前 signal 已 abort 的输入不会被记录。

`Session.continue()` 从现有 Context 开始，不增加 input event。
`AgentApplication.retry()` 仅在确认最近持久化 Run 失败后使用它。

## Run

**Run** 是 Agent loop 的一次执行。`May.run()` 从用户消息开始，`May.continue()` 从
现有 Context 开始。二者都返回 handle：

```ts
interface RunHandle {
  readonly id: string;
  readonly events: AsyncIterable<MayEvent>;
  readonly result: Promise<RunResult>;
  cancel(reason?: string): void;
}
```

Run 在以下任一条件发生时结束：

- 模型返回不含工具调用的最终 assistant 消息；
- 超过最大 Step 数；
- model、Context、scheduler、持久化或 fatal tool execution 失败；
- abort signal 或 `cancel()` 取消执行。

`RunResult` 报告 run id、已完成 Step 数、模型调用数、工具调用数、最终 assistant
消息，以及可用时的 provider aggregate usage。Run 失败或取消时 `result` 会 reject；
如果消费者需要观察终态，仍应消费或转发其事件。

Core 默认拒绝重叠 Run，因为一个 `May` 实例拥有可变 Context。`Session` 还会对提交
排队。更高层的 `AgentApplication` 会拒绝第二个活动 application 操作，而不是排队。

## Step

**Step** 是一次模型请求，加上执行返回 assistant 消息中的全部工具调用：

```text
step.started
  -> Context snapshot / optional automatic compaction
  -> model.started
  -> zero or more model deltas or retry notices
  -> model.completed (complete assistant message)
  -> zero or more tool executions
  -> step.completed
```

若 assistant 消息没有工具调用，同一个 Step 就完成 Run；若包含工具调用，其结果消息
追加到 Context，Run 继续下一个 Step。因此一个 Step 可以包含多个工具调用，`maxSteps`
限制的是模型/工具迭代次数，不是工具数。

默认工具 scheduler 串行执行，但 Core 暴露可替换的 `ToolScheduler`。无论调度策略
如何，返回 outcome 都必须与原始 tool-call 顺序一致。普通工具失败转成错误 tool
消息，模型可在下一个 Step 恢复；fatal tool failure 会在记录 outcome 后结束 Run。

## 取消与不完整工具调用

取消通过 `AbortSignal` 协作完成。工具执行期间取消时，Core 等待已启动操作 settle，
为没有 outcome 的调用创建取消结果，把完整工具消息集追加到 Context，在
`run.cancelled` 前发出可用 outcome。这避免工作对话里出现没有对应结果的 assistant
tool call。

恢复时，如果 Run 被取消，Session 也会检测没有持久化 outcome 的 assistant tool call，
并重建取消 tool message。这是为维持模型可见一致性进行的回放修复，不会把临时 progress
变成持久化 history。

## 身份与顺序

存在两个独立 sequence domain：

- 每个 `MayEvent` 有 Run 内的 `runId` 与 `seq`，从 1 开始；
- 每个 `SessionEvent` 有 Session 内的 `sessionId` 与连续 `seq`，也从 1 开始。

Step 编号只在 Run 内有效。工具操作还通过 `ToolExecutionContext` 携带 Run id、Step、
tool-call id 和 idempotency key。

不要只根据实时 Run sequence 推断持久化连续性。背压下 streaming event 可能丢失，
而读取 history 时会校验 Session sequence 连续。参阅[事件与持久化](events.md)。

## 哪些内容会持久化

Session 保存提交消息、完整 assistant 消息、工具 outcome、审批、压缩 checkpoint、
应用工具 presentation 和 Run 边界。它不保存 Step 开始/完成、model start、streaming
delta、model retry notice、tool start 或 tool progress。

因此 Session history 能重建有效模型对话，但不是逐字节执行 trace。它与当前 Context
的关系见 [Context 与持久化历史](context-and-history.md)。

## 当前限制

Session 当前只有一条串行 Run stream，并假定给定 history 只有一个活动 writer。
Session fork、跨进程并发 writer 和分布式执行协调尚未实现。
