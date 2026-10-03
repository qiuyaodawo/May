# @may/plugin-history-memory

`budget` 接受 Context 预算，或者接受使用有效 Model 计算预算的 callback。
callback 在 Model wrappers 应用之后执行，可以使用 provider 插件提供的容量。

`createHistoryMemoryPlugin(options?)` 提供 `historyMemoryService` 和
`services.contextOptions`，注册 Context 容量查询与工作笔记工具，包装 Context
factory，并在 `application.created` 中连接实际 application。
`mode` 可以选择 `prune-summary`、`history-reference` 或 `provider-native`。
显式指定的自动压缩策略覆盖模式配置；选项还接受预算、summarizer 和手动压缩策略。

`historyMemoryService` 提供实际 memory 实例，以及手动、summary、history-reference
和 native 策略。工作笔记保存在带版本的插件状态中，同时保留
`maybecode.context-notes` 历史记录。重置要求笔记覆盖当前输入和工具结果，保留当前
用户请求，并保留完整历史用于查询。接受输入和关闭 application 时取消尚未执行的
重置请求。`HistoryReferenceMemory` 和 `createModelContextSummarizer` 继续支持直接组合。

参见 [English version](README.md)。
