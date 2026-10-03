# @may/plugin-runtime

`createRuntimePlugin(factory?, id?)` 提供 `services.runtimeFactory`。
默认工厂创建 Core 的实际 `May` Runtime。Application 管理返回的 Runtime，
负责保存、迁移和关闭，并在释放插件资源之前关闭 Runtime。
也接受 `{ id?, factory?, create?, dispose?, ...metadata }`，`create(context)`
返回 Runtime 工厂，并可以使用声明的服务和持久状态。提供自定义来源时选择 `factory` 或 `create`。

`createContextPlugin({ id?, create?, options?, dispose? })` 提供 `services.contextFactory`，
默认使用 `InMemoryContextFactory`。`options` 作为 `contextOptions` 服务，
接受配置对象或接收当前有效 Model 的函数。每个 Application 分别调用 `create(context)`。
通过 `dispose(factory)` 和 `context.defer()` 管理资源。

`createContextWrapperPlugin({ id, create, order?, dispose? })` 注册
`create(context)` 返回的 `(factory) => ContextFactory`。
包装按照顺序应用，最后应用的包装首先接收 `create()` 调用。

`createToolsPlugin({ id, create, order?, dispose? })` 注册工厂返回的工具来源：
`() => Iterable<Tool>`。插件清理时自动移除条目，实际资源通过 `context.defer()` 注册清理。
多个来源组合成工具目录，为每次 Run 保存快照，并检查重复名称。
工厂支持 [`PluginFactoryMetadata`](../../plugin-services/README.zh-CN.md) 中带类型的
`config`、`configSchema`、依赖、`requiresHooks`、`state` 和 `version`。
setup 之前验证配置，并自动声明需要的注册表依赖。

测试使用实际文件资源、Core Runtime 工厂和独立 Context 实例。
执行 `pnpm --filter @may/plugin-runtime test`。
