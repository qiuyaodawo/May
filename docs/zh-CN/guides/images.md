# 展示图片回复

[English](../../en/guides/images.md) | **简体中文**

消息通过 `ContentPart[]` 保留文字、图片、后续文字的原始顺序。
OpenAI Responses 将 `image_generation_call.result` 转换为 base64 图片内容，
同时保留原始续接状态。MaybeCode 也能展示已有会话的 OpenAI 原始输出中的图片，
不改写会话日志。

本文指导宿主展示已经包含受支持图片内容的模型响应、选择终端协议，
或为其他 UI 和渠道提供媒体读取。所选模型需要支持请求的图片操作。

## MaybeCode

1. 在选定 Session 中打开包含图片的回复。
2. 终端使用已保存的附件路径，或选择支持的图片协议。
3. Web UI 使用原图和下载链接。

### 保存附件

Terminal 将内嵌图片保存到 `~/.may/media/`，在对话中显示完整路径、MIME 类型、
尺寸和文件大小。可以使用图片查看器打开文件，或者通过 `/web` 查看和下载。
Readline 界面收到图片后，会按照原始顺序打印完整图文回复；此前流式输出的文字
仍保留在终端中。

### 终端图片协议

两种 Terminal 界面都支持 Kitty、iTerm2 和 Sixel 图片协议，使用
`supports-terminal-graphics` 自动检测，通过 `WT_SESSION` 识别 Windows Terminal。
对于可能支持 Sixel 的终端，使用 DA1 查询确认能力，并通过 CSI 16 t 获取字符
像素尺寸。`MAY_IMAGE_PROTOCOL` 支持 `kitty`、`iterm2`、`sixel`、`none`、`auto`。
显式选择 `sixel` 时无需 DA1 确认，仍然需要字符尺寸响应。自动模式在 tmux/screen
和非 TTY 输出中显示附件信息。没有返回所需 Sixel 响应的终端也显示附件信息。

Sixel 预览保持宽高比例，最多占用 80 列和 12 行，像素上限为 1280 × 768，
使用最多 256 种颜色。透明区域使用白色预览背景。编码使用独立的像素缓冲区，
保持像素位置和缓存源图的数据完整。保存的原始文件保留透明度和
原始质量。窗口变化时重新查询字符尺寸，Retained 界面重新绘制图片，Readline
界面后续输出的图片使用新尺寸。图片占用独立的显示行，完整位于可见区域内才会
显示。滚动、窗口尺寸变化和对话框显示时，旧的 Retained 图片位置会被清除。
模型文字中的控制序列不会作为图片命令执行。

在 PowerShell 中显式选择 Sixel，并启动 MaybeCode：

```powershell
$env:MAY_IMAGE_PROTOCOL = "sixel"
pnpm maybecode
```

### Web 与其他图片来源

Web UI 保留图文顺序，提供原图和下载链接。读取内嵌图片需要鉴权，并验证图片属于
指定会话或任务。消息列表传递附件标识，图片数据单独读取。图片元素移除后，释放
对应的 browser object URL。HTTP(S) 图片由浏览器直接加载，不携带宿主凭据或
referrer；图片是否继续可用取决于来源服务器。Terminal 显示这些链接。
Provider file ID 需要宿主提供 `MediaReader`。

## 复用接口

读取或转换图片的宿主需要依赖 `@may/media`，并管理读取接口和存储的生命周期。
下面的接口说明媒体边界；UI 组合见[自定义 UI](custom-ui.md)。

`@may/media` 导出 `DisplayPart`、`ImageAttachment`、`ImageData`、`MediaReader`、
`MediaCapabilities`、`displayParts`、`imageAttachment`、`readEmbeddedImage`、
`inspectImage`、`imagePng`、`FileMediaStore`。运行时依赖为 `@may/core` 和
`sharp`，Agent 运行循环无需依赖它。

图片校验支持 PNG、JPEG、WebP、GIF、AVIF，限制为 32 MiB 和 4000 万像素。
不支持的格式和 MIME 类型不一致都会产生错误。Terminal 和渠道转换格式时使用
PNG 图片帧。宿主通过 `ApplicationUiOptions.readMedia` 或 `UiHost.media`
接入图片读取。媒体接口接收会话或任务标识及附件标识，不接收任意文件路径。
`FileMediaStore` 支持自定义目录和读取接口，`TerminalImages` 支持指定 store
及协议，第三个参数可以提供 `{ cellSize: () => ({ width, height }) }` 字符像素尺寸。
Sixel 绘制需要这些尺寸。`NodeTerminalDriver.imageSupport` 和
`createNodeTerminal().imageSupport` 提供 `TerminalImageSupport`，终端响应与
键盘输入分别处理。Retained driver 自动启动查询，Readline 宿主调用 `query()`
并等待 `ready()` 后输出初始图片。`TerminalImages.revision` 随图片准备及字符
尺寸变化而更新。Component 通过 `RenderResult.images` 独立传递图片位置，
Sixel 图片位置包含编码后的 `sixel` 序列。

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

## 验证展示与投递

在目标 UI 中使用实际包含图片的响应，确认图文顺序、附件 MIME 类型与尺寸，
以及保存的原图能够访问。终端图片需要确认所选终端返回要求的能力信息。
渠道投递中断后，尝试重新发送之前检查已经保存的投递记录。
