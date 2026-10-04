# @may/plugin-delegation

`createWorkspaceFilesPlugin({ workspace, defaultTools? })` 提供
`workspaceFilesService`，根据选项注册默认编码工具。共享文件守卫串行执行文件访问，
检查子任务的文件范围，要求子任务修改已有文件前完成读取，并检测其他进程的修改。

`createDelegationPlugin(options)` 声明文件服务、application、model、store、permission
和组合服务的依赖，提供 `delegationService`。在 `application.created` 完成后，
`get()` 返回实际 `SubagentHost`。Setup 注册请求预算的模型包装、动态委派工具与
指令；created Hook 恢复请求记录并初始化 coordination，关闭时取消活动子任务。

每个子 Agent 保留独立 Session、Run 身份、权限、Context、角色限制及共享请求账本。
带版本的插件状态保存请求索引，同时保留 `may.subagents` 历史记录。被中断的操作
需要核对结果，恢复时不会自动重复执行。Package 同时导出 `SubagentHost`、配置、
预算、文件、指令和请求类型，以及 `host`、`configuration`、`budget`、`files`、
`instructions`、`types` subpath。

默认 Context 预算根据活动 Model 的 limits 计算。显式 `contextBudget` 优先，
角色指定的模型保留各自配置的限制与 Context 预算。
提供 `goalsService` 时，默认模型和角色指定的子模型共同遵守 Goal 的 token 计量、
预算检查和取消信号。子任务的 Context 保留各自的任务指令。

Application 提供 `mcpService` 时，delegation 声明这项可选依赖，并在每次子 Run
开始时读取连接池的当前工具目录。子工具调用保留自己的 Session 身份、权限和请求预算。

参见 [English version](README.md)。
