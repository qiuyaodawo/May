# `@may/plugin-agent-adapters`

`createAgentAdaptersPlugin({ factories, id? })` 创建 `host` scope 插件，提供
`agentAdapterRegistryService`。`factories` 是 `Record<id, factory>` 或返回这些 factory
的函数。Registry 在 `get(id)` 时创建并验证实例，重复请求共享同一次创建；
`release(id)` 关闭并删除缓存，下一次 `get(id)` 创建新的实例；`list()` 读取当前配置。
factory 可以从宿主当前配置读取模型、权限和目录。插件关闭等待正在创建或关闭的实例，
不会提前创建全部 Agent。创建失败交付给 `get()` 的调用方，未接收的候选资源会关闭。

`createMayAgentAdapter({ agentId, store, definition, media?, metadata? })` 管理实际
AgentApplication 对话。`definition(toolsSource, contextSource)` 由宿主注入，负责配置模型、工具、
权限和插件；`store` 提供持久化与恢复，`metadata(conversationId)` 提供宿主身份。
Adapter 保留重复输入检测、暂停和继续、审批、工具结果核查、对话释放与删除。
存储支持删除时才声明 `delete` 能力。

`MayAgentAdapterOptions.modelCapabilities(refresh?)` 提供异步模型能力查询，并作为
`AgentAdapter.modelCapabilities()` 暴露给宿主。`refresh` 由调用方明确请求，回调负责
返回当前 provider 的能力与探测结果。`diagnostics(application, { limit?, offset? })`
为当前活动 AgentApplication 提供分页诊断查询；adapter 的
`diagnostics(conversationId, query?)` 在对话尚未打开或已经释放时返回 `undefined`。
这两个可选回调分别用于模型配置检查和运行诊断，调用方负责数据格式及观察资源管理。

`contextSource()` 返回当前对话正在执行的 `AgentAdapterContext`；没有执行时返回
`undefined`。宿主通过 `permissionScope` 提供可信发起者身份，定义工厂可以在每次
权限检查时读取当前身份。不同对话的 Context 独立管理。
`resolveApproval(conversationId, requestId, decision, options?)` 将
`allow-persistent` 与 `{ createdBy, expiresAt? }` 传入实际 AgentApplication。
宿主负责批准身份与范围验证，以及共享 PermissionRuleStore 的生命周期。

`loadAgentAdapter({ id, module, export?, options? }, factoryContext?)` 加载模块的
`createAdapter()`，检查必需方法、能力声明和相应控制方法。模块需要返回
`AgentAdapter`；附加宿主参数由 `factoryContext` 注入。

`createGatewayRpcAdapter(agentId, options)` 通过 `vscode-jsonrpc` 使用 stdio 或 socket。
结果无法确认时返回 `RpcOutcomeUnknownError`；查询可以重新连接，产生副作用的方法
不会自动重新执行。协议检查能力声明、请求身份、回调所属执行和工具访问范围。
工具调用执行自身 `parse()` 并保护最终参数。

`AgentAdapterContext.telemetry` 传递经过 `validateTelemetryCorrelation()` 验证的
version 1 身份与父 span。RPC 在 `gateway/initialize` 请求中声明 `telemetryVersion: 1`；
远端返回同一版本后，`conversation/execute` 才包含独立的 `telemetry` 字段。省略该响应
字段的远端继续接收原执行字段。未知版本、未知字段和非法身份在发送前导致验证失败。
远端需要在开始执行前验证 envelope，业务输入的重复请求判断不包含遥测身份。

`@may/plugin-agent-adapters/examples/rpc-file-agent` 提供实际文件计算服务，支持
SHA-256、等待文件、取消、对话记录、输入状态查询、补充输入和删除。状态读取、
写入和更新通过 `AsyncStateSerializer` 顺序执行；文件等待与取消执行使用独立流程。
示例协商 version 1 遥测，并在任务记录中独立保存 `telemetry`；`inputHash` 仅描述业务
输入。完成后的重复请求返回已保存结果，并保留原执行的遥测身份。测试启动真实子进程
并验证文件结果、恢复、创建失败、并行查询、遥测传播、协议验证、关闭和资源退出。
