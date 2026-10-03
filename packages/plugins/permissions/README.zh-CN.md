# @may/plugin-permissions

`createPermissionPlugin({ id?, create, dispose? })` 提供 `services.permissionPolicy`。
`create(context)` 为一个 Application 返回实际 permission policy。
通过 `dispose(policy)` 和 `context.defer()` 管理资源清理。
传入已有 policy 并省略 disposer 时，该实例由调用方管理。
支持 [`PluginFactoryMetadata`](../../plugin-services/README.zh-CN.md) 中带类型的
`config`、`configSchema`、依赖、`requiresHooks`、`state` 和 `version`。
取得资源之前验证配置，`create(context)` 可以读取声明的服务和持久状态。

Application 管理审批请求、权限事件保存和 `PermissionToolExecutor`，
每次判定权限时取得当前服务。每种 policy 服务具有一个提供方，重复提供方在 setup 之前报错。

测试使用实际文件资源判定权限，并验证不同作用域分别关闭资源。
执行 `pnpm --filter @may/plugin-permissions test`。
