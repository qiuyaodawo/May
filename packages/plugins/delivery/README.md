# `@sortedyuan/plugin-delivery`

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

`ChannelAdapter.name` 与 `ChannelAttachmentSource.platform` 使用渠道自定义的名称。
附件 `source` 保存该渠道读取附件需要的字符串字段，例如
`{ platform: "local-files", documentId: "report.txt" }`。公共验证检查字段数量、
名称和字符串长度；adapter 的 `readAttachment()` 校验自身字段以及附件访问权限。
一个 `source` 最多包含 32 个字段，字段名称与 `platform` 最长 128 个字符，
字段值最长 4096 个字符，全部字段均为非空字符串。

升级附件处理代码时，在所属 adapter 中校验并读取 `source.fileId`、
`source.messageId` 等字段。`ChannelStore` 负责渠道记录；应用迁移检查由宿主提供。

`ChannelStore.inspect()` 与写入操作通过 `<journal-path>.access` 和
`<journal-path>.access.gate` 文件协调不同
进程的读取、追加、修复和检查点替换。查询保持日志内容不变；首次访问创建协调文件，
需要目录写入权限，后续查询以只读方式打开这些文件。升级已有存储时，停止相关宿主，使用
具有目录写入权限的账户执行一次 `inspect()`，然后配置监控进程的只读权限。
共享目录的全部进程需要同时升级。有活动读取者或写入者时，保留访问协调文件。

离线测试使用实际文件记录、Unicode 文字和标准 Response。外部平台的发送验证需要
有效凭据和授权的测试会话。
