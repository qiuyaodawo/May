# @may/plugin-services

为 `@may/application` 和组件插件提供带类型的服务标识以及有序组合注册表。
`services` 中的全部服务使用 application 作用域和 `1.0.0` 版本，每种服务具有一个提供方。
`applicationServices` 导出相同的服务标识，并增加实际 Application 的访问服务。

`model`、`modelInfo`、`contextFactory`、`permissionPolicy`、`runtimeFactory`、`sessionStore`、
`skills`、`toolExecutor`、`toolScheduler` 和 `tracer` 描述组件实例。
`tools` 接受一个已有的 iterable。多个插件贡献功能时，使用 `toolSources`、
`instructionSources`、`modelWrappers` 和 `contextWrappers`。

`modelInfo` 可选地描述活动 Model，包含 `provider`、`model` 及可选的 `adapter`、
`profile` 字段。使用方声明可选依赖；Model 没有元信息时，其名称保持未知。
Model 工厂共同提供实例及对应的元信息。

注册表提供 `add(value, { id, order?, pluginOrder? }): Disposer`。
组合顺序依次依据 `order`、插件声明顺序和注册序号，数值较小的条目优先执行。
重复的贡献标识立即报错。通过 `context.defer()` 注册返回的清理函数，插件关闭时移除条目。

```ts
context.defer(context.get(services.toolSources).add(
  () => tools,
  { id: context.pluginId, pluginOrder: context.pluginOrder },
));
```

`ToolSources.snapshot()` 返回保存当前定义和执行函数的 `ToolRegistry`，重复工具名称立即报错。
Application 为每次 Run 保存目录快照。`InstructionSources.snapshot()` 读取当前内容，
使用空行连接非空字符串。工具来源和指令来源需要同步返回。

`ModelWrappers.apply(base)` 和 `ContextWrappers.apply(base)` 按照注册顺序包装输入实例。
最后执行的包装位于最外层，调用时首先经过它。每个 Application 创建独立注册表，
创建 Runtime 时应用包装。原始组件仍然可以通过其服务标识取得。
包装需要返回有效组件；工厂使用 `context.defer()` 管理取得的资源。

`contextOptions` 接受 `ContextOptions` 或 `(effectiveModel) => ContextOptions`。
Application 在应用 Model 包装之后，为每个 Runtime 读取配置。
配置包含 `budget`、`compactionStrategy`、`autoCompactionStrategies` 和
`providerNativeAutoCompaction`，summarizer 可以使用当前 Model 及其控制能力。
该配置由一个插件提供。

组件工厂接受 `PluginFactoryMetadata<C>`：带类型的 `config`、`configSchema`、
`version`、`requires`、`optional`、`requiresHooks` 和 `state`。
setup 之前验证配置，`create(context)` 中保留配置类型。
依赖声明包含工厂及其返回组件使用的服务。工厂自动加入贡献注册表依赖，
相同服务的明确声明可以指定版本范围和能力要求。Skills 工厂管理激活状态的格式。

测试使用真实文件资源和独立的 InMemory Context 实例。
执行 `pnpm --filter @may/plugin-services test`。
