# 图片回复

[English](../../en/guides/images.md) | **简体中文**

消息通过 `ContentPart[]` 保留文字、图片、后续文字的原始顺序。
OpenAI Responses 将 `image_generation_call.result` 转换为 base64 图片内容，
同时保留原始续接状态。MaybeCode 也能展示已有会话的 OpenAI 原始输出中的图片，
不改写会话日志。

## MaybeCode

Terminal 将内嵌图片保存到 `~/.may/media/`，在对话中显示完整路径、MIME 类型、
尺寸和文件大小。可以使用图片查看器打开文件，或者通过 `/web` 查看和下载。
Readline 界面收到图片后，会按照原始顺序打印完整图文回复；此前流式输出的文字
仍保留在终端中。

Retained renderer 支持 Kitty 和 iTerm2 图片协议，使用
`supports-terminal-graphics` 自动检测。`MAY_IMAGE_PROTOCOL` 支持 `kitty`、
`iterm2`、`none`、`auto`。自动模式在 tmux/screen 和非 TTY 输出中显示附件信息。
其他图片协议也采用附件信息展示。图片占用独立的显示行，完整位于可见区域内才会
显示。滚动、窗口尺寸变化和对话框显示时，旧的图片位置会被清除。模型文字中的
控制序列不会作为图片命令执行。

Web UI 保留图文顺序，提供原图和下载链接。读取内嵌图片需要鉴权，并验证图片属于
指定会话或任务。消息列表传递附件标识，图片数据单独读取。图片元素移除后，释放
对应的 browser object URL。HTTP(S) 图片由浏览器直接加载，不携带宿主凭据或
referrer；图片是否继续可用取决于来源服务器。Terminal 显示这些链接。
Provider file ID 需要宿主提供 `MediaReader`。

## 复用接口

`@may/media` 导出 `DisplayPart`、`ImageAttachment`、`ImageData`、`MediaReader`、
`MediaCapabilities`、`displayParts`、`imageAttachment`、`readEmbeddedImage`、
`inspectImage`、`imagePng`、`FileMediaStore`。运行时依赖为 `@may/core` 和
`sharp`，Agent 运行循环无需依赖它。

图片校验支持 PNG、JPEG、WebP、GIF、AVIF，限制为 32 MiB 和 4000 万像素。
不支持的格式和 MIME 类型不一致都会产生错误。Terminal 和渠道转换格式时使用
PNG 图片帧。宿主通过 `ApplicationUiOptions.readMedia` 或 `UiHost.media`
接入图片读取。媒体接口接收会话或任务标识及附件标识，不接收任意文件路径。
`FileMediaStore` 支持自定义目录和读取接口，`TerminalImages` 支持指定 store
及协议。Component 通过 `RenderResult.images` 独立传递图片位置。

## 飞书与 Telegram

MaybeClaw adapter 声明 `MediaCapabilities`，接收经过校验的 `ImageData`。
Telegram 使用 multipart `sendPhoto` 发送满足格式和尺寸要求的图片，其他图片
使用 `sendDocument`。飞书使用 `image_type=message` 上传 PNG，再发送对应的
`image_key`，转换后的文件不能超过 10 MiB。应用需要具备平台的图片上传和发送权限。

包含图片的回复按照原始顺序发送文字消息和图片消息。每条消息独立保存投递状态、
图片引用和前一条消息标识。重启后不会重新发送已经确认的消息。无法确认结果的
发送记录标记为 `unknown`，后续消息暂停发送。用户显式发送 `/result <task-id>`
会创建新的顺序投递记录。图片 URL 以链接形式发送；无法读取的 Provider file ID
显示附件提示。等待投递期间，需要保留图片所属的任务会话。

其他渠道提供自身的平台操作并声明支持的媒体能力，即可复用图片校验、附件标识、
媒体读取及有序内容。
`ChannelHub` 和 `MaybeClawUiHost` 可以接收自定义 `MediaReader`，用于读取其他来源。
