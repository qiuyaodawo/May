---
"@may/core": minor
"@may/context": minor
"@may/provider-openai": minor
---

`ModelContextCompactionResult` 新增 `usage`：provider 原生压缩据此上报压缩请求自身的
usage，OpenAI Responses 的 `/responses/compact` 已经解析该 usage 并直接返回；没有 usage
的压缩器仍然可以只返回消息。

`ContextSummaryRequest` 新增 `runId` 与 `step`，`SummaryTailStrategy` 把触发压缩的
Run 身份传给摘要器，可复用的模型摘要器再把它交给 `Model.stream`。使用同一个模型的
计账方因此可以为 Run 内的摘要调用给出可追踪的调用身份。
