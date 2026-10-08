# @may/application

`AgentApplication.getOptionalService(token)` 查询已经提供的 plugin service，
缺失时返回 `undefined`。`responseFormat` 配置 Core 的统一结构化输出。
tracer 转发独立指标，并为 Run 关联 Session ID。参见
[模型能力与执行诊断](../../docs/zh-CN/guides/model-telemetry-integration.md)。

`defineAgent(options)` 保存可复用的 Agent 配置，`agent.open({ store, ... })`
创建或恢复一个 Session。`AgentApplication.open()` 支持直接使用相同配置。
`submit()`、`continue()`、`retry()`、`steer()` 和 `startSteeringInput()`
共用运行互斥、事件转发和保存过程。`continue()` 保留当前上下文并继续运行。
`AgentWorkspace` 管理 Session 目录、恢复、切换和有序 Application 更新。

`AgentApplication.open()` 和 `defineAgent()` 接受 `permissionRuleStore`，
在多个 Application 和程序重启后复用持久权限规则。调用方管理存储实例及其生命周期。
宿主 policy 提供可信的 `persistent: { scopeId, description }` 范围和稳定的 `grantKey`。
`resolveApproval(id, "allow-persistent", { createdBy, expiresAt? })` 完成规则保存后
允许工具执行，`createdBy` 由宿主依据操作人员身份提供。
`listPermissionRules(scopeId?)`、
`createPermissionRule(check, { decision, createdBy, expiresAt? })` 和
`revokePermissionRule(id)` 提供规则管理，`AgentWorkspace` 转发到当前 Application。
规则创建、使用和撤销记录保存在 Session 历史中，模型 Context 保持独立。
Session 分支根据新宿主范围检查配置的规则存储。
`createPermissionRuleFrom(sourceId, { decision, createdBy, expiresAt? })`
根据已有可信范围创建新的允许或禁止规则，保留范围、工具定义身份和授权范围键。
宿主验证操作人员对来源规则的管理权限后提供这一操作。

`agent.open({ store, fork: { sessionId, positionSeq } })` 从完整请求的可恢复位置创建
独立 Session。`branchPositions()` 返回准确的历史位置；Run 作用域关闭并完成状态
保存后，Application 才将该位置标记为可用。Skills 激活状态随位置恢复，
宿主确认调度 yielded 的请求已经完成并保存最终状态后，可以调用
`saveBranchPosition(runId, { allowYielded: true })` 保存成功边界。
`forkStateKeys` 和 `forkPluginIds` 声明需要继承的应用与插件状态。
`forkStateTransform(key, value)` 调整新环境中的资源位置。审批授权、活动资源和未
消费输入保持独立。

`AgentWorkspace.readSessionBranchTree()` 返回持久保存的来源关系和历史位置。
`forkSession(sourceId, positionSeq, { workspace?, metadata? })` 使用同一个
`openApplication` 工厂创建并选择新 Session。工厂收到 `fork`、`workspace` 和
`metadata`，宿主据此重建目录对应的工具和指令。可选 `workspacePaths` 返回相关
工作区路径，使 Session 列表、历史、重命名、删除和分支树共同覆盖这些目录。
恢复时工厂收到保存的工作区路径，`workspace` 始终反映当前 Application。

`plugins` 接受带依赖声明的插件定义，每个 Application 创建独立的 application、session
和 run 作用域。直接传入的 Model、Context、permissions、tools、Skills 和 Runtime
配置通过组件插件工厂提供；相同基础服务具有一个提供方，重复提供方在 setup 之前报错。
已有直接调用保持兼容，调用方传入的实例由调用方管理。

`applicationServices` 包含 `@may/plugin-services` 的相同服务标识。
组装的提示词内容变化时，使当前 Context 的 provider token 计量失效。后续检查使用
更新后的内容估计，直到重新记录 provider usage。
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

手动和自动压缩保存 `context.compacted` 后调用 controller 的
`commitCompaction(result)`，然后通知 `compactionCompleted`。保存失败时恢复原来的
Context；完成 Hook 失败时继续传递错误，并保留已经保存的消息，使当前 Context
与恢复 Session 使用相同消息。提供恢复能力的自定义 controller 也应实现这一成功保存边界。

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

`@may/application/git-workspace` 提供 Node.js `ProjectGitWorkspace`，默认初始化项目
Git 管理并保存初始文件 checkpoint。每次完整请求通过 `beginRound()`、
`lease.complete()` 保存最终文件版本；组件提供当前 branch、结构化 diff、
文件恢复预览和持久化 worktree 管理。
宿主通过 `authorizeCommit` 执行项目要求的提交授权。
详见 [Git 工作区与文件 checkpoint](../../docs/zh-CN/guides/git-workspaces.md)。
