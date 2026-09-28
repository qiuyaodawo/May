---
"@may/provider-openai-compatible": patch
"@may/provider-deepseek": patch
"@may/provider-kimi": patch
"@may/provider-zhipu": patch
---

Chat Completions 兼容流检测服务端顶层 `error`，HTTP 200 内的错误不再被忽略。
`@may/provider-openai-compatible` 导出的 `streamOpenAICompatibleResponse` 在遇到带顶层
`error` 的 chunk 时立即通过 `protocolError` 失败，可见的错误消息保留服务端的 `message`、
`type` 和 `code`（字符串或数字）；`error` 为空或形状非法时给出明确的诊断消息。该失败不
会被流末尾的 `[DONE]` 或 `finish_reason` 判定覆盖，也不会产生成功的 `response.completed`。
`OpenAICompatibleChunk` 新增可选的 `error` 字段，`OpenAICompatibleStreamError` 描述其内容。
共享该 stream 的 deepseek、kimi、zhipu adapter 一并获得此行为，错误类别和自动重试判定保持
原状。
