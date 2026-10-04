# @may/plugin-goals

`createGoalsPlugin(options?)` 提供 `goalsService`，通过组合服务注册
`GoalController` 的模型包装、Context 包装和动态工具。插件声明 application
访问服务与相关 registry 的依赖，在 `application.created` 中连接实际 Session，
在 `application.beforeClose` 中停止目标调度，然后释放资源。

目标状态保存在带版本的插件状态中，同时保留 `may.goal` Session 记录供历史查询。
恢复时保留已完成的目标，并暂停被中断的目标，等待用户明确继续。Token 统计使用
provider 返回的实际 usage。`validateBudget` 和 `verify` 保留 `@may/goal` 的含义。
`createAgent(application)` 可以通过插件管理的 delegation host 执行目标 Run。
`goalsService` 提供的 controller 支持
`wrapModel(model, { includeInstructions: false })`，子模型遵守 Goal 的 token 计量、
预算和取消信号，并使用子任务的指令。

参见 [English version](README.md)。
