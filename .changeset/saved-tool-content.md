---
"@may/core": minor
"@may/session": minor
"@may/session-tools": patch
---

保存工具执行时的模型可见 `content`，在 Session 恢复及历史工具查询时使用该内容。
host 历史接口继续保留原始 `output`。`@may/session` 提供 `sessionToolResultContent`。

Breaking change（0.x minor）：自行构造 Core `tool.completed` 事件的调用方必须提供 `content`，
其值应当来自工具执行后生成的 `ToolMessage.content`。自定义 Session 存储应保留此字段。
已有记录缺少 `content` 时，模型收到内容不可用提示；需要恢复具体内容的 host 应根据
可信的历史记录补充模型可见内容。工具不会自动重新执行。
