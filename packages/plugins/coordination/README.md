# `@may/plugin-coordination`

`createCoordinationPlugin({ id? })` 创建 `host` scope 插件，提供 `coordinationService`。
服务的 `create(options)` 和 `resume(options)` 接收 `@may/coordination` 的完整参数，
返回原来的 `CoordinationRuntime`。宿主提供 Agent、访问策略与存储，实现任务路由。

`release(runtime)` 关闭 Runtime 并删除管理记录。宿主完成一个任务图后调用该方法，
长期运行不会保留所有已关闭的 Runtime。插件关闭等待正在创建的 Runtime，并关闭
其余受管理资源。正在关闭的 scope 收到新建实例时，会关闭候选实例并拒绝使用。
Runtime 的原有重复关闭行为保持有效。

测试实际读取文件并保存 SHA-256 结果，验证任务完成、恢复、重复关闭和独占写入资源
再次获取。
