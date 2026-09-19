---
"@may/provider-openai-compatible": minor
"@may/provider-openai": patch
"@may/provider-anthropic": patch
"@may/provider-deepseek": patch
"@may/provider-kimi": patch
"@may/provider-zhipu": patch
---

提供 `@may/provider-openai-compatible/http`，共用 SSE 读取与 `Retry-After` 处理。
SSE 使用 `eventsource-parser`，支持 UTF-8 分段、LF/CRLF/CR、流结束及中止后的连接释放。
各个 provider 保留其协议完成条件与错误类型。
