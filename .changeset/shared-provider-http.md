---
"@sortedyuan/provider-openai-compatible": minor
"@sortedyuan/provider-openai": patch
"@sortedyuan/provider-anthropic": patch
"@sortedyuan/provider-deepseek": patch
"@sortedyuan/provider-kimi": patch
"@sortedyuan/provider-zhipu": patch
---

提供 `@sortedyuan/provider-openai-compatible/http`，共用 SSE 读取与 `Retry-After` 处理。
SSE 使用 `eventsource-parser`，支持 UTF-8 分段、LF/CRLF/CR、流结束及中止后的连接释放。
各个 provider 保留其协议完成条件与错误类型。
