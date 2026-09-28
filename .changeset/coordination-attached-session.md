---
"@may/coordination": minor
---

新增宿主已经持有 Session 的任务适配器 `createAttachedApplicationAgent`：
宿主提供 Session 所有者与每轮的 submit 选项，agent 负责输入身份、让出边界与任务
取消信号，并且拒绝第二个执行方并发认领同一个 Session，也不打开或关闭宿主的
application。`CreateCoordinationOptions.sessionIds` 允许根任务直接使用宿主已有的
Session。`TaskSpec.files` 声明任务可以修改的工作区相对文件，委派工具接受并校验
该字段。`delegationTool`（导出为 `createDelegationTool`）新增 `agents`、
`guidance` 与 `maxInputBytes` 选项，使描述与限制由宿主决定。
`FileSharedBudget` 新增 `reserveCall`、`settleCall`、`markCallUnknown` 与
`runExternal`，供宿主在模型调用之外（例如 provider 原生上下文压缩）预留并计账。
`runExternal(id, reservation, operation)` 按结果中的 provider usage 结账；结果没有
usage 时按预留值保守计账，并在账本中把该次调用标记为 `estimated`。
`SharedBudgetTotals` 新增 `usageComplete`：只有每次调用都按 provider 上报的 usage
结账时它才为 `true`，因此估计值不会被当成完整统计。
`sharedBudgetTotals` 在账本没有配置 `maxTotalTokens` 或 `maxCostUsd` 时不再因为单次
调用超出预留值而阻塞，调用次数上限仍然生效。
`validateTaskFiles` 导出用于校验文件声明。
`createApplicationAgent` 新增 `onOpen` 回调，允许宿主在提交任务前将独立的会话状态绑定到
刚打开的 application。
`resolveRecovery` 允许宿主在 runtime 尚未启动且没有活动任务时，为 queued 或 waiting
任务记录经过核对的终态，支持中断请求的人工处理。任务尚未提交输入就失败时保留原始错误信息。
