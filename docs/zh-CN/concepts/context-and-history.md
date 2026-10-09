# Context 与持久化历史

[English](../../en/concepts/context-and-history.md) | **简体中文**

长对话中，Agent 可能需要减少下一次模型请求的消息数量，应用仍需保留完整记录以便恢复。
Context 保存当前模型视图，Session 历史保存持久化对话事实。压缩替换模型视图，
原始历史继续保留。

生命周期术语见 [Session、Run 与 Step](session-run-step.md)，事件映射见
[事件与持久化](events.md)，各个包的职责见
[Runtime 与 Session 边界](../architecture/runtime-session.md)。

## 两种不同视图

| 关注点 | Context | Session 历史 |
| --- | --- | --- |
| 主要消费者 | 模型请求 | 恢复、审计、UI、历史工具 |
| 最小接口 | `snapshot()` 与 `append()` | `SessionStore.append()` 与 `read()` |
| 内容 | 指令、选中的消息、请求元数据 | 持久化 `SessionEvent` 事实 |
| 可压缩 | 是 | 保留既有事件 |
| 必须包含增量内容 | 否 | 否 |
| 拥有 Session 身份 | 否 | 是 |
| 重建工具/模型/策略 | 否 | 否 |

`@may/core` 的最小 `Context` 接口不依赖持久化。Core 在每次模型调用前请求快照，
并在执行过程中追加用户、助手和工具消息。指令作为 `system` 消息进入模型请求，
Context 元数据作为请求元数据传递。

`@may/context` 增加 `ContextFactory` 和可选的 `ContextController` 管理能力。内置
`InMemoryContextFactory` 返回内存模型视图，以及用于检查和替换的控制器。
自定义工厂可以省略控制器，因此应用必须处理检查或压缩不可用的情况。

<a id="检查与-budget"></a>

## 检查与容量预算

`ContextController.inspect()` 报告消息数、各个角色的消息数量、序列化 UTF-8 字节数、
工具结果数量和 token 用量。缺少测量值时，以 UTF-8 字节数除以四得到近似 token 数量。

Provider 报告输入 token 用量时，`AgentApplication` 同时记录测量值和模型请求的消息数。
控制器结合已经测量的消息与之后追加消息的估算值，计算当前用量。
`ContextBudget` 可以为输出、工具和安全空间预留容量，并定义自动压缩触发比例。

这些数值用于判断容量，精确计费需要 Provider 报告的实际用量。

## 压缩检查点

压缩策略接收快照并返回替换消息列表。内置策略可以缩短较早的大型工具结果、
生成早期对话摘要、调用 Provider 原生压缩，或用持久化历史引用替换旧对话。
产品代码决定策略顺序和提示内容。

手动压缩通过控制器或应用调用。达到容量阈值时，自动压缩
在模型快照生成前执行。策略按顺序运行，直到用量低于阈值或某个终结策略
成功。策略失败可以继续尝试后续策略；全部用尽时抛出错误，不能悄悄发送仍超阈值的请求。

替换成功后，`AgentApplication` 记录 `context.compacted` Session 事件，其中包含：

- 策略名称；
- 完整替换消息视图；
- 压缩前后消息数量和估算 token 数。

该事件是持久化检查点，此前的 Session 事件继续保留。恢复按顺序读取历史；
遇到检查点时替换已经重建的消息列表，再应用后续输入、助手消息和工具结果。

只有实际发生变化的压缩结果才会持久化。手动调用方直接得到结果。成功自动压缩还会
发出应用事件；自动策略失败通过实时应用事件报告。

## 历史引用模式的工作记忆

MaybeCode 的 `history-reference` 模式使用工作笔记和按需历史查询，不调用模型生成
全历史摘要。底层 `HistoryReferenceStrategy` 保留近期用户轮次；应用层的该模式
可以在同一个很长的用户任务内部重置上下文。

- 模型通过 `get_context_remaining` 主动查询估算用量、窗口容量和重置前剩余空间；
  未知的限制明确返回未知，不当作零。
- 达到压缩阈值的 80% 时，系统每个窗口加入一次 `system` 提醒。原阈值仍是强制边界，
  大型结果可能直接跨过提醒区间。
- `context_notes` 读取或替换一份工作笔记，保存到 Session 状态。保存要求包含
  `goal`、`constraints`、`progress`、`nextSteps`，可选 `historyRefs` 引用最多
  20 个已有事件序号，JSON 总大小不超过 12 KiB。笔记可恢复，不同 Session 互相隔离。
- 先完成工具工作，再单独调用工具保存笔记，随后单独调用 `new_context`。系统在
  下一次模型调用前、当前工具结果持久化后重新检查笔记。新用户输入、非记忆工具结果、
  恢复状态变化或上一次历史重置，都会要求重新保存笔记。
- 新视图保留宿主指令、其他 `system` 消息、最新用户请求和笔记，不保留整轮工具记录。
  笔记缺失、过时、交接内容过大或工具恢复未处理时，拒绝重置。检查能确认笔记的新旧，
  不能证明模型写下的内容准确。
- 投影后的事件仍可查询。`session_history_search` 每次最多扫描 50 条事件，返回最多
  10 个不区分大小写的字面匹配；空页也应根据游标继续。`session_history_read` 按
  序号分段读取完整记录，默认 2000、最多 4000 个 UTF-16 代码单元，使用返回的
  `nextOffset` 继续。查询不返回压缩事件中的替换视图。
  成功工具事件提供保存的模型可见 `content`；宿主历史 API 仍可读取原始 `output`。

只有自动历史引用模式暴露 `new_context` 并加入主动指导和提醒。其他模式也提供查询
与笔记工具，便于准备手动历史重置。自定义 Context 需要支持延迟压缩和回滚。检查点
持久化失败时，内置控制器恢复原视图，不会携带失败的替换结果继续调用模型。
笔记写入失败也会停止 Run；修复存储并重新打开会话后才能继续。
该模式不会自动转为摘要或原生压缩。

## 回放语义

`Session.resume()` 校验 Session 标识和连续序号，然后从持久化事件重建模型视图：

- `input.submitted` 恢复用户消息；
- `assistant.completed` 恢复完整助手消息；
- `tool.completed` 与 `tool.failed` 恢复工具消息；
- `context.compacted` 替换截至该点重建的全部消息；
- 已取消 Run 中，若助手工具调用没有持久化结果，则补充合成取消消息。

`tool.completed.content` 保存执行当时的模型可见工具结果，包括媒体和空数组。恢复
过程和三个模型历史工具共用 `sessionToolResultContent(event)`。旧记录缺少这个字段
时提供明确的内容不可用提示。`Session.history()` 与 `Session.queryHistory()` 仍为
宿主提供原始 `output`；需要把旧结果加入模型上下文时，由宿主明确审核并添加内容。

回放还会向运行时工厂返回最近可用的 Provider 输入 token 测量值。压缩检查点
会清除更早的测量，因为被测量的消息前缀已经变化。

审批事件、Run 边界和 `tool.presentation` 可以通过历史查询。工具显示信息属于应用
元数据，回放仅使用模型对话内容。

指令、工具、模型选择、权限策略和任意产品配置也不会从事件日志重建；
应用创建恢复后的运行时必须注入它们。历史保存对话事实，应用配置由宿主重新提供。

<a id="读取持久化-history"></a>

## 读取持久化历史

`Session.history()` 等待待处理记录写入后返回全部已校验事件。
`Session.queryHistory()` 提供有界分页，支持：

- 不包含边界值的 `afterSeq` 和 `beforeSeq`；
- 升序或降序；
- 事件类型过滤；
- 仍有匹配事件时返回 `nextSeq` 游标。

默认页大小为 50，内置读取器最大为 1000。应用可通过
`AgentApplication.open({ sessionHistory: ... })` 显式启用有界 `session_history`
工具；默认不安装。

内置存储为 `InMemorySessionStore` 和仅 Node 可用的 `FileSessionStore`，后者每个
Session 写一个明文 JSONL 文件。文件存储会在单实例内串行写入，不提供跨进程锁、
加密、崩溃恢复事务或多个写入者的安全保证。

## Catalog 与 History

`SessionCatalog` 是可列出的 `SessionSummary` 索引。每条记录包含 `id`、`workspace`、
`createdAt`、`lastUsedAt`，以及可选的 `title`、`preview` 和 `turnCount`。

`AgentWorkspace` 使用 Catalog 发现候选标识，再通过 SessionStore 读取历史恢复对话。
内置 SessionStore 按 Session 标识读取，跨 Session 列表由 Catalog 提供。

默认 Workspace 摘要使用第一条用户文本作为标题，最近一条用户或助手文本
作为预览，已提交输入数作为轮次数量。内置 Catalog 按 `lastUsedAt` 降序列出某个
Workspace 的记录。普通 Run 前后的 Catalog 写入失败不会阻止对话，因此摘要缺失
或过期不表示底层历史不存在。

Catalog 重命名只改变投影，不追加 Session 事件。Session 删除和 Catalog 移除是两个
独立操作，可能部分成功。本地 `FileSessionCatalog` 原子追加操作文件，
保留多个 Catalog 实例的更新；操作目录需要明确维护。

## 为功能选择事实来源

- 用 **Context** 表示模型下一次调用应看到什么。
- 用 **Session 历史** 表示持久化对话事实与回放数据。
- 用 **Catalog** 快速发现 Session 并展示摘要。
- 用 **实时事件** 表示动画、部分输出与当前进度。

UI 可以投影这些数据，持久化历史提供恢复依据。管理这些层级的编排边界见
[Agent definition、Application 与 Workspace](agent-application.md)。
