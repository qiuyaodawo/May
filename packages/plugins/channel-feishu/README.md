# `@may/plugin-channel-feishu`

`createFeishuChannelPlugin({ settings, secret, id? })` 创建 `host` scope 插件，
要求 `deliveryServices.registry`，提供 `feishuChannelService`。插件 setup 创建
`FeishuAdapter` 并注册输入读取，defer 取消并等待任务结束。宿主只为启用的渠道创建
插件；凭据由宿主提供，插件状态保存不包含凭据。

`settings` 包含 `enabled`、`appId`、`allowUsers` 与可选的群组访问条件。
Adapter 确认 Bot 身份并通过官方 SDK 管理 WebSocket；宿主接收函数负责保存输入，
执行 Agent 的任务由宿主调度。SDK 日志经过关闭处理，凭据和平台消息正文不会输出。
投递通过 native fetch 发送一次请求，回复与 topic 路由保留原始身份。

包内导出 `feishuInput()`、`feishuMemberInputs()`、`feishuRecallInput()`、
`feishuDeliveryRequest()` 与 `feishuImageRequest()`。图片上传使用真实图片解码与
PNG 转换；附件下载检查原始消息、授权条件和大小限制。

离线测试覆盖消息、撤回、成员事件、回复参数和实际 PNG 转换。平台身份、WebSocket
接收、投递和附件下载需要有效 Feishu 应用凭据及授权会话验证。
