# `@may/plugin-channel-telegram`

`createTelegramChannelPlugin({ settings, token, id? })` 创建 `host` scope 插件，
要求 `deliveryServices.registry`，提供 `telegramChannelService`。插件 setup 创建
`TelegramAdapter` 并注册输入读取，defer 取消并等待任务结束。宿主只为启用的渠道创建
插件；凭据由宿主提供，插件状态保存不包含凭据。

`settings` 包含 `enabled`、`allowUsers`、可选的 `allowGroups`、`groupTrigger` 与
`entranceTriggers`。构造时复制这些访问条件；后续修改需要替换插件。
输入事件完成宿主保存和 cursor 保存后，下一次 `getUpdates` 才确认平台进度。
Adapter 检查 Bot 身份和 webhook 状态，公开连接状态与平台限流条件。

`telegramInput()`、`telegramMemberInput()` 转换平台事件；
`telegramDeliveryRouting()` 保留回复与 topic 身份；`telegramImageRequest()`
根据图片格式和大小选择 `sendPhoto` 或 `sendDocument`。附件读取检查来源和访问条件，
发送方法每次调用执行一次平台请求。

离线测试覆盖事件转换、topic/reply 参数和实际 PNG 内容。平台身份、接收、发送和
附件下载需要有效 Telegram Bot 凭据及授权会话验证。
