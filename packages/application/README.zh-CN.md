# @may/application

`defineAgent(options)` 保存可复用的 Agent 配置，`agent.open({ store, ... })`
创建或恢复一个 Session。`AgentApplication.open()` 支持直接使用相同配置。
`submit()`、`continue()`、`retry()`、`steer()` 和 `startSteeringInput()`
共用运行互斥、事件转发和保存过程。`continue()` 保留当前上下文并继续运行。
`AgentWorkspace` 管理 Session 目录、恢复、切换和有序 Application 更新。

`plugins` 接受带依赖声明的插件定义，每个 Application 创建独立的 application、session
和 run 作用域。直接传入的 Model、Context、permissions、tools、Skills 和 Runtime
配置通过组件插件工厂提供；相同基础服务具有一个提供方，重复提供方在 setup 之前报错。
已有直接调用保持兼容，调用方传入的实例由调用方管理。

`applicationServices` 包含 `@may/plugin-services` 的相同服务标识。
多个插件通过 `toolSources`、`instructionSources`、`modelWrappers` 和 `contextWrappers`
贡献能力，并通过 `context.defer()` 管理移除和资源清理。
组合顺序依据 `order`、`context.pluginOrder` 和注册顺序。
创建 Runtime 时应用 Model 和 Context 包装，原始服务仍然返回基础组件。
`contextOptions` 接受配置对象或接收当前有效 Model 的函数。
打开 Application 时检查工具名称，每次 Run 保存独立工具目录快照。
可选 `modelInfo` 描述活动 Model，其字段共同传入 Runtime trace attributes。
Model 工厂共同提供实际实例及这一服务。
标准 `may.model` 标签使用这一服务。元信息缺失时保持这些标签缺失，插件替换后
继续依据当前元信息生成标签；其他 trace attributes 继续保留。

`applicationServices.application` 提供 `ApplicationAccess.get()`。
在 `application.created` handler 中能够取得实际 `AgentApplication` 并调用其控制和状态接口。
在 setup 期间过早访问会立即报错。Application 引用保存在访问服务中，Hook payload
使用可以复制和验证的数据。`applicationHooks` 支持创建、关闭、输入、压缩、审批和恢复，
创建和关闭通知同时传递给 Session 插件以及上级 handler，并保持声明的执行顺序。
`application.beforeCreate` 执行之前准备 Session 状态和服务。
Core `runtimeHooks` 支持 Run、Step、Context、Model 和工具执行。

`updatePlugins(plugins, { cancelActive? })` 验证完整依赖关系，等待当前操作结束，
保存并关闭旧 Runtime，更新插件资源，并创建新的 Runtime。
新的插件再次收到 `application.created`，可以关联现有 Application。
更新期间暂停开始 Run，初始化失败之后可以再次调用 `updatePlugins()` 进行修复。
`cancelActive: true` 在更新之前取消当前操作。关闭 Application 时等待操作完成，
并在释放插件资源之前关闭 Runtime。

Model、permissions、Context/Runtime/tools 和 Skills 的插件工厂分别由
`@may/plugin-models`、`@may/plugin-permissions`、`@may/plugin-runtime` 和
`@may/plugin-skills` 提供。Skills 的激活内容使用带版本的插件状态保存，
恢复 Session 时兼容已有的 `may.skills.active.v1` 记录。

`getService(token)` 取得当前启用的服务；`recordState(key, value)` 保存 Application 状态。
关闭期间拒绝新的 Agent 操作，允许生命周期 handler 和结算过程完成状态保存，
并等待已经接受的写入。关闭完成之后拒绝新的状态写入。
`sessionHistory: { retrieval: true }` 提供当前 Session 的有限历史读取和查询工具。
`pluginHookTimeoutMs` 控制 handler 时限，`onPluginHookError` 接收允许独立报告的 observation 错误。
插件状态在恢复时验证版本并进行声明的迁移。

详见[插件指南](../../docs/zh-CN/guides/plugins.md)。离线验证使用
`pnpm --filter @may/application test`，真实 provider 集成验证使用
`pnpm --filter @may/application test:integration`。
