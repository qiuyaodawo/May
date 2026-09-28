---
"@may/config": minor
---

`may-config.schema.json` 增加 `apps.maybecode.subagents`：委派开关、角色（模型、
reasoning effort、指令、工具、可委派角色、Run 预算）、并发与深度等限制、子 Agent 的
`runBudget`，以及一次请求共享的 `maxModelCalls`、`maxTotalTokens` 与
`reservationTokens`。`false` 或 `{ "enabled": false }` 关闭子 Agent 委派。
子 Agent 的 `runBudget` 缺省为 24 步、24 次模型调用与 48 次工具调用，一次请求共享的
`maxModelCalls` 缺省为 128。
