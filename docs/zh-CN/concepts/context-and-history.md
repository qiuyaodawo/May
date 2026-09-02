# Context 与持久化历史

[English](../../en/concepts/context-and-history.md) | **简体中文**

May 有意区分下一次模型调用可见的消息与 Session 保存的持久化事实。这样可以替换或
压缩 Context，同时不破坏审计历史。

生命周期术语见 [Session、Run 与 Step](session-run-step.md)，事件映射见
[事件与持久化](events.md)，package ownership 见
[Runtime 与 Session 边界](../architecture/runtime-session.md)。

## 两种不同视图

| 关注点 | Context | Session history |
| --- | --- | --- |
| 主要消费者 | 模型请求 | 恢复、审计、UI、history tool |
| 最小接口 | `snapshot()` 与 `append()` | `SessionStore.append()` 与 `read()` |
| 内容 | 指令、选中的消息、请求 metadata | 持久化 `SessionEvent` 事实 |
| 可压缩 | 是 | 保留既有事件 |
| 必须含 streaming delta | 否 | 否 |
| 拥有 Session 身份 | 否 | 是 |
| 重建工具/模型/策略 | 否 | 否 |

`@may/core` 的最小 `Context` 契约不依赖持久化。Core 在每次模型调用前请求 snapshot，
并在执行过程中追加用户、assistant 与 tool 消息。指令成为模型请求中的 system message；
Context metadata 成为请求 metadata。

`@may/context` 增加 `ContextFactory` 和可选的 `ContextController` 管理能力。内置
`InMemoryContextFactory` 返回内存模型视图以及用于检查和替换的 controller。自定义
factory 可以省略 controller，因此应用必须处理检查或压缩不可用的情况。

## 检查与 Budget

`ContextController.inspect()` 报告消息数、role 数量、序列化 UTF-8 字节数、tool-result
数量和 token 压力。回退 token 估算明确只是近似值：UTF-8 字节数除以四。

Provider 报告 input-token usage 时，`AgentApplication` 会同时记录该测量值以及模型
请求包含的消息数。Controller 可把已测量前缀与之后追加消息的估算结合起来。
`ContextBudget` 可以为输出、工具和安全空间预留容量，并定义自动压缩触发比例。

这些值是容量信号，不是计费值，也不是精确 tokenizer 结果。

## 压缩改变 Context，而不是 History

压缩策略接收 snapshot 并返回替换消息列表。内置策略可以裁剪较早的大型工具结果、
总结早期 turn、使用 provider 原生压缩，或用持久化历史引用替换旧 turn。产品代码
决定策略顺序和 prompt 策略。

手动压缩通过 controller 或 application 调用。达到 budget threshold 时，自动压缩
可以紧邻模型 snapshot 前执行。策略按顺序运行，直到压力低于阈值或某个终结策略
成功。策略失败可以继续尝试后续策略；全部用尽时抛出错误，不能悄悄发送仍超阈值的请求。

替换成功后，`AgentApplication` 记录 `context.compacted` Session event，其中包含：

- 策略名称；
- 完整替换消息视图；
- 压缩前后消息数量和估算 token 数。

该事件是持久化 checkpoint，**不会**重写或删除此前 Session event。恢复时按顺序扫描
history；遇到 checkpoint 就替换已重建的消息列表，然后正常应用后续持久化 input、
assistant 消息和工具 outcome。

只有实际发生变化的压缩结果才会持久化。手动调用方直接得到结果。成功自动压缩还会
发出 application event；自动策略失败是实时 application event，目前不是 Session event。

## 回放语义

`Session.resume()` 校验 Session id 和连续 sequence，然后从持久化事件重建模型视图：

- `input.submitted` 恢复 user message；
- `assistant.completed` 恢复完整 assistant message；
- `tool.completed` 与 `tool.failed` 恢复 tool message；
- `context.compacted` 替换截至该点重建的全部消息；
- 已取消 Run 中，若 assistant tool call 没有持久化 outcome，则补充合成取消消息。

回放还会向 runtime factory 返回最近可用的 provider input-token 测量。压缩 checkpoint
会清除更早的测量，因为被测量的消息前缀已经变化。

审批事件、Run 边界和 `tool.presentation` 在 history 中可见，但不是模型消息。尤其是
tool presentation 属于应用显示 metadata，回放时会被有意忽略。

指令、工具、模型选择、permission policy 和任意产品配置也不会从 event log 重建；
应用创建恢复后的 runtime 时必须注入它们。因此 history 是对话的事实来源，而不是
序列化 Agent definition。

## 读取持久化 History

`Session.history()` 等待待处理 record write 后返回全部已校验事件。
`Session.queryHistory()` 提供有界分页，支持：

- exclusive `afterSeq` 和 `beforeSeq` 边界；
- 升序或降序；
- event-type filter；
- 仍有匹配事件时返回 `nextSeq` cursor。

默认页大小为 50，内置 reader 最大为 1000。应用可通过
`AgentApplication.open({ sessionHistory: ... })` opt-in 有界 `session_history`
工具；默认不安装。

内置存储为 `InMemorySessionStore` 和仅 Node 可用的 `FileSessionStore`，后者每个
Session 写一个明文 JSONL 文件。File store 会在单实例内串行写入，但不提供跨进程锁、
加密、crash recovery transaction 或多 writer 安全。

## Catalog 与 History

`SessionCatalog` 是可列出的 `SessionSummary` 索引：

```text
id + workspace + createdAt + lastUsedAt + optional title/preview/turnCount
```

它不是 Session event store，无法独自恢复对话；反过来 SessionStore 也不提供内置的
跨 Session 列表。`AgentWorkspace` 同时使用两者：Catalog 发现候选 id，SessionStore
提供 history。

默认 workspace summary 使用第一条用户文本作为标题，最近一条用户或 assistant 文本
作为预览，已提交输入数作为 turn count。内置 Catalog 按 `lastUsedAt` 降序列出某个
workspace 的记录。普通 Run 前后的 Catalog write 是 best-effort，因此 summary 缺失
或过期不表示底层 history 不存在。

Catalog rename 只改变投影，不追加 Session event。Session 删除和 Catalog 移除是两个
独立操作，不是原子 commit。本地 `FileSessionCatalog` 通过原子追加 operation file
避免多个 Catalog 实例之间的 lost update，但不会自动压缩 operation directory。

## 为功能选择事实来源

- 用 **Context** 表示模型下一次调用应看到什么。
- 用 **Session history** 表示持久化对话事实与回放数据。
- 用 **Catalog** 快速发现 Session 并展示摘要。
- 用 **实时事件** 表示动画、部分输出与当前进度。

UI 可以投影四者，但 retained widget 都不是事实来源。拥有这些层级的编排边界见
[Agent definition、Application 与 Workspace](agent-application.md)。
