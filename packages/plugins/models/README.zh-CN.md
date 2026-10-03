# @may/plugin-models

`createModelPlugin({ id?, create, info?, dispose? })` 提供 `services.model`。
传入 `info` 时，工厂同时提供 `services.modelInfo`，记录实际的 `provider`、
`model` 及可选的 `adapter`、`profile`。省略 `info` 时保持元信息缺失，使用方
通过可选服务依赖读取元信息。
`create(context)` 为一个 Application 创建实际 Model，关闭插件时执行 `dispose(model)`。
创建期间取得的资源通过 `context.defer()` 注册清理，包括发生错误之前取得的资源。
传入已有 Model 并省略 disposer 时，该实例由调用方管理。
两种工厂接受 [`PluginFactoryMetadata`](../../plugin-services/README.zh-CN.md) 的
`config`、`configSchema`、依赖声明、`requiresHooks`、`state` 和 `version`。
创建之前验证配置，`context.config` 保留声明的类型。

`createModelWrapperPlugin({ id, create, order?, dispose? })` 贡献有序 Model 包装。
`create(context)` 返回 `(model) => Model`，资源通过 `context.defer()` 管理。
Application 每次创建 Runtime 时应用全部包装，最后应用的包装首先接收 stream 调用。
每个 Application 使用独立注册表，并分别执行工厂。

```ts
const plugin = createModelPlugin({ create: () => providerModel });
```

Model 和包装注册表分别作为服务提供，重复提供方在 setup 之前报错。
Runtime 集成测试使用真实 DeepSeek provider，包测试使用实际文件资源验证检查和清理行为。
