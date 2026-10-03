# `@may/plugin-delivery`

`createDeliveryPlugin({ ingress, id? })` 创建 `host` scope 插件，要求宿主提供
`ServiceToken<ChannelIngress>`。`ChannelIngress` 包含 `store`、`receive(input)`、
可选的 `ready` Promise 和 `onError(account, error)`。渠道读取等待 `ready`，
插件关闭会取消等待；宿主负责存储资源的生命周期。

插件提供 `deliveryServices.registry` 与 `deliveryServices.delivery`。
`registry.register(adapter)` 注册渠道并启动输入读取，返回关闭函数；`get(account)`、
`list()` 和 `errors()` 提供实例与后台错误查询。每个 account 只允许注册一次，
关闭函数取消输入读取并等待任务结束。意外失败通过 `onError` 和 `errors()` 公开，
资源清理保留失败信息。

`delivery.attempt(adapter, record, { signal, image?, commit })` 只执行一次投递。
`commit("sending")` 完成后调用 `adapter.send()`；发送完成后保存 `sent` 与 receipt，
发送结果无法确认时保存 `unknown` 并拒绝返回。相同投递 ID 不能同时执行。
宿主提供访问控制、投递顺序、消息路由、保存结果与人工核查。

包内提供 `ChannelAdapter`、`ChannelInput`、`ChannelRecord`、`DeliveryRecord`、
`ChannelState` 等共享接口，`ChannelStore` 保存独占写入的 JSONL 记录，
以及分页、访问条件和有大小限制的读取函数。重新打开 ChannelStore 会移除未完成的
末尾记录，将未确认的 `sending` 记录保存为 `unknown`。调用方必须在整个使用期间
持有自己的独占资源；`close()` 支持重复调用。

离线测试使用实际文件记录、Unicode 文字和标准 Response。外部平台的发送验证需要
有效凭据和授权的测试会话。
