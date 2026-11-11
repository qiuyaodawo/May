# 使用 MaybeCode

[English](../../en/guides/maybecode.md) | **简体中文**

通过终端或浏览器使用编码 Agent。按照[仓库开发指南](repository-development.md)
准备仓库。首次启动引导可以创建 Provider 和模型配置，更多设置见
[配置参考](../reference/configuration.md)。
应用使用所选模型的 API，并在启动目录中执行工作。

通过 `MaybeCodeApplicationOptions.tools` 提供的自定义工具注册到应用工具目录。
运行指令使用同一个目录描述当前环境。

## 配置网页搜索

通过 Provider 或模型的 `options.webSearch: {}` 启用服务端搜索；智谱需要
`{ "searchEngine": "search_std" }`。支持的字段和 adapter 限制见
[配置参考](../reference/configuration.md#服务端搜索)。该配置授权服务端执行，
包括由 `allowedCallers` 或搜索版本默认值选择的 Anthropic code execution。
`/model` 显示当前搜索方式。

宿主搜索通过 `apps.maybecode.webSearch.hostTool` 设置
`{ "backend": "deepseek", "provider": "deepseek" }`，引用已配置凭据的 Provider。
支持 `deepseek`、`zhipu`（需要 `searchEngine`）和 `kimi-formula` 后端。
每次 Run 开始时，服务端搜索优先；其他情况下 MaybeCode 提供宿主工具。
Formula 工具要求使用 `kimi-chat`。宿主搜索请求审批并记录用量。
设置 `apps.maybecode.webSearch: false` 可以关闭搜索，此时选择每次回复都会搜索的模型将失败。

## 配置语言服务器

将 `apps.maybecode.lsp.servers` 设置为 `{ "typescript": {}, "python": {} }`，
即授权这些服务器进程。使用工具前，在项目内或 PATH 中安装对应程序：

```sh
npm install -g typescript-language-server typescript
npm install -g pyright
rustup component add rust-analyzer rust-src
go install golang.org/x/tools/gopls@latest
```

根据配置的 `typescript`、`python`、`rust` 或 `go` 预设选择对应命令。
May 要求 Node.js 22.16.0 或更高版本；安装的语言服务器还有各自的运行环境要求。
服务器在首次使用时启动。容器执行要求镜像或工作区包含服务器命令、运行环境和
缓存的项目依赖。参阅 [LSP 工具](../../../packages/tools/lsp/README.zh-CN.md)。

`/lsp` 显示解析后的命令、状态、进度、最近错误和 stderr。
`/lsp restart <id>` 停止服务器并清除连续退出造成的失败状态，下一次请求再次启动服务器。
省略 `lsp` 或设置为 `false` 时关闭相关工具。配置的服务器提供诊断、定义、引用、
hover、文档符号、工作区符号和重命名功能。位置使用从 1 开始的行号和 UTF-16 列号，
也可以提供准确的符号和可选的出现次数。重命名审批显示所有修改文件；
计划生成后文件发生变化时，在写入之前报告冲突。

edit 和 write 默认返回诊断；`lsp.editDiagnostics: false` 关闭该反馈。
只有 `complete` 且列表为空时，才能确认当前版本没有报告问题。
`pending` 表示等待诊断，`unknown` 表示诊断没有版本号，
`unavailable` 表示文件已经写入成功，随后诊断反馈发生错误。
`lsp_diagnostics` 可以请求更新结果。子 Agent 角色可以选择已注册的 `lsp_*`
和宿主 `web_search` 工厂；team 的各个 worktree 使用独立执行环境和语言服务器管理器。

## 启动应用

对于 `anthropic-messages` adapter，MaybeCode 默认使用
`promptCaching: { "ttl": "5m", "cacheInstructions": true }`。将 Provider 或模型的
`options.promptCaching` 设置为 `false` 可以关闭缓存。五分钟写入价格为基础输入价格的
1.25 倍，一小时写入为 2 倍，读取通常为 0.1 倍。最小缓存长度取决于模型，参阅
[配置说明](../reference/configuration.md)。兼容端点拒绝 `cache_control` 时需要关闭缓存。

MaybeCode 要求 Node.js 22.16.0 或更新版本。

在 May 仓库根目录执行：

```bash
pnpm maybecode
```

该命令构建后启动应用。浏览器界面按照 [WebUI 步骤](web-ui.md)生成
`MAYBECODE_CONTROL_TOKEN`，然后执行 `pnpm maybecode --ui web`。
提交任务前核查显示的工作目录和模型。

## 首次启动配置

当 `~/.may/config.json` 不存在时，交互式终端会显示英文配置向导。
标准输入和标准输出都需要连接终端。指定 `--config <path>` 时，向导会询问是否在该
位置创建文件。已有文件出现读取、JSON 或字段校验错误时，应用显示错误并结束。

1. 确认显示的完整配置路径。
2. 选择 Provider，或选择 **Custom compatible service** 并指定 API 协议。
   输入 base URL；提示会说明 Adapter 在地址后追加的请求路径。
3. 选择当前进程能够读取的环境变量，或通过隐藏输入填写 API Key。
   直接输入的 API Key 以明文保存在配置文件中；环境变量方式只保存变量名称。
4. 输入模型 ID 和配置名称。启动参数包含 `--model` 时，使用对应名称。
   高级设置支持 token 限制，以及使用 JSON 填写提示中列出的 Adapter 选项。
   按 Enter 保留显示的值，输入 `:clear` 删除对应的高级设置。
5. 按需执行连接检查。检查通过实际 Adapter 发送 **Reply with OK.**，超时为
   30 秒，可能产生 API 费用。请求只包含检查文字。失败后保留输入，允许修改并重试。
   跳过检查时显示 **Connection: Not verified**。
6. 检查配置并选择 **Save and start**。配置以完整文件发布后，由正常启动流程重新
   读取，并打开所选界面。此次创建的模型配置成为 `defaultModel`。

通过开始确认之后，每个问题都支持按 Esc 返回上一个问题，包括菜单、文字和密码
输入。菜单也可以选择 **Back**。重新进入问题时保留已经填写的值。
整个向导共用同一个终端显示区域。`Ctrl+C` 取消配置并以退出码 130 结束。
菜单通过上下方向键选择，按 Enter 确认。开始确认页面按 Esc 取消配置。密码输入隐藏所有字符，
并且不会保存到输入历史。
保存前输入保存在内存中，取消后配置文件仍然不存在。保存时创建父目录，并与其他配置
使用者协调文件访问。如果其他进程已经创建该文件，向导终止保存并保留已有文件。
存储位置需要支持 hard link，以便发布完整文件。后续应用启动失败时保留已保存的配置。

retained 和 Web 模式共用终端向导。Web 模式在进入向导前检查
`MAYBECODE_CONTROL_TOKEN`。工作目录、会话恢复、权限和端口参数继续交给正常启动流程。
非交互环境缺少配置时，应用输出操作说明并以退出码 1 结束。
help、MCP 和 team 命令保持各自的启动行为。

CLI 按需加载选中的命令和界面。图片需要处理时加载图片编码模块，打开 `/web` 时
加载 Web 服务和浏览器资源。启动过程打开 Session 并识别仓库。首次可能修改工作区文件的
工具获得权限后，在执行之前初始化 Git 并准备 checkpoint。只读请求不创建 checkpoint。
尚未建立 Git 版本的工作区显示“Git 尚未准备”。

每次启动默认创建新的 Session。正常退出时，MaybeCode 删除本次运行创建且没有提交消息、
排队消息、Run 或 goal 的 Session；重新启动后，这些 Session 不再出现在 `/resume` 中。
输入框中尚未提交的内容不会保留 Session。恢复的 Session 和通过 `/fork` 创建的 Session
会继续保留。

Git 管理默认启用，可能初始化项目仓库并创建 checkpoint。在项目中执行工作前，
配置 `apps.maybecode.git` 及需要的提交审批，参阅
[Git 配置](../reference/configuration.md#maybecode-项目-git-管理)。

## 在 PowerShell 中运行本地 MaybeCode 构建

需要在其他项目目录使用本地构建时，将以下内容添加到 `$PROFILE.CurrentUserAllHosts`，
替换为自己的仓库路径。PowerShell 7 和 Windows PowerShell 使用各自的 Profile。

```powershell
. 'E:\code\May\scripts\maybecode-powershell.ps1'
```

打开新终端，或者执行 `. $PROFILE.CurrentUserAllHosts`。构建仓库后进入项目目录：

```powershell
pnpm --dir E:\code\May build
Set-Location E:\code\your-project
pnpm maybecode
```

函数启动 `apps/maybecode/dist/bin.js`，保留当前目录，并传递 `--continue`、`--config`
和 `--ui web` 等参数。重新构建后重启应用。构建入口缺失时提示需要执行的构建命令。
其他 pnpm 命令使用 `pnpm.cmd`；仓库中的 `pnpm run maybecode` 使用 package script。
通过 `-NoProfile` 启动的终端需要明确加载脚本。

安装 package 后可以使用独立的 `maybecode` 命令。需要移除已有的全局开发安装时，
执行 `pnpm remove --global @sortedyuan/maybecode`。

## 控制工具审批

默认编码工具包括 `read`、`glob`、`grep`、`shell`、`edit`、`write` 和 `fetch`。
使用 `glob` 查找文件名称，使用 `grep` 搜索文件内容；两者遵循 `.gitignore`，
并限制输出和执行时间。只读集合包含 `read`、`glob` 和 `grep`。`fetch` 读取
HTTP/HTTPS 文字，将 HTML 转换为便于阅读的文字，不携带宿主凭据或 cookie。
默认允许公网地址；`apps.maybecode.fetch.allowedOrigins` 将访问范围限制为列出的
origin，也可以明确允许本地服务。每次重定向重新检查地址。网络访问具有独立审批
类别，默认模式需要审批。

默认模式在执行命令或修改文件之前请求批准。`--yolo` 开启自动审批，`--no-yolo`
覆盖配置中的 YOLO 默认模式。通过 `/yolo on` 或 `/yolo off` 切换之前，暂停或取消
活动工作。`/yolo` 同样开启模式，`/yolo status` 查询状态。

终端和 WebUI 在开启期间显示 **YOLO · Auto-approve**。WebUI 还提供 **Permissions**
选择器。权限策略明确禁止的操作继续被拒绝。模式范围、重新启动行为、持久规则及
独立的团队授权见[权限模式](../reference/configuration.md#maybecode-权限模式)。

## 配置执行隔离

`apps.maybecode.execution` 默认值为 `{ "mode": "host" }`。宿主命令使用启动账户的
权限和环境变量。容器模式要求 Docker Desktop 或兼容运行时，且服务已经启动。
启动应用前拉取镜像：

```bash
docker pull nixery.dev/shell/git/ripgrep/util-linux
```

镜像必须包含 `bash`、`git`、`rg` 和 `setsid`。按照[配置参考](../reference/configuration.md)
设置镜像和资源限制。Docker、镜像或所需程序不可用时，应用启动失败。

应用管理长期运行的容器。shell、搜索和委派工具使用其执行环境；team 检查继承执行配置。
工作区挂载到 `/workspace`，命令工作目录从宿主路径转换为容器路径。
文件工具继续通过宿主工作区检查访问同一份文件。容器使用非 root 用户、只读根目录、
临时存储、关闭的网络、内存和 CPU 限制及受限权限。挂载范围排除 home、凭据和
Docker socket。取消时等待命令终止，应用关闭时等待执行资源清理和容器删除。

MCP server 继续在宿主运行。`fetch` 使用独立的宿主网络策略和审批类别。

## 在 MaybeCode 执行期间发送消息

普通消息取消当前操作，等待取消完成后在同一 Session 开始新请求。`/steer <消息>`
等待当前 Step 及工具、审批完成后交付补充输入。消息保存后按照接收顺序交付。
空闲时启动 Run；完成或宿主让出执行权后仍待交付的输入，在当前操作结束后执行。

`/stop` 和 Web 取消按钮取消活动工作与待交付输入。终端没有选择文字时，`Ctrl+C`
执行相同操作。已取消的补充输入保留在历史中，需要重新提交才会执行。retained TUI
和 WebUI 均支持这些操作。

## 查看 MaybeCode 对话

retained TUI 和 Web 历史将保存的恢复核查结论显示为用户消息，Web 搜索及完整字段
读取包含全部内容。两个界面均保留工具被拒绝、未执行和结果未知的区别；Run 在回复
完成前结束时，部分回复标记为中断。

默认 retained TUI 在支持 xterm 鼠标报告的终端中提供滚轮浏览。每次事件滚动三行，
保留输入与焦点。向上滚动后保留阅读位置；返回底部后继续跟随新输出。

retained TUI 输入框使用 `Ctrl+J` 插入换行，使用 `Enter` 提交输入。
输入框中的上下方向键选择输入历史。按下 Tab 切换至对话区域，使用上下方向键、
PageUp、PageDown、Home 和 End 浏览内容。

按下 `Ctrl+G` 后按下 `R`，显示当前轮次已完成的最终回复开头。保留输入与焦点，
直到手动滚动前保持阅读位置。恢复 Session 和长回复同样支持。最终回复尚未完成时，
状态显示 **No final reply yet**。

拖动鼠标选择文字。`Ctrl+C` 复制已选择的内容；没有选择时中断工作或退出空闲界面。
输入框支持 `Ctrl+A`、`Ctrl+X` 和 `Ctrl+V`，Shift+方向键及 Shift+Home/End 扩展
选择范围。Home/End 移动至逻辑行开头或末尾，输入与粘贴替换已选择的内容。拖动至
显示区域边缘时滚动，复制保留缩进与换行。

`Ctrl+G D` 切换工具详情，`Ctrl+G T` 切换思考内容。起始按键后的等待没有截止时间，
保留阅读位置；Escape、切换焦点、鼠标浏览或弹窗结束等待。`MAY_TUI_LEADER` 设置
包含修饰键的起始按键，需要检查它与输入框及终端快捷键的冲突。

`MAY_CLIPBOARD` 支持 `auto`（本机系统剪贴板）、`system`、`osc52` 和 `disabled`。
通过 SSH 使用时选择 `osc52`，允许终端写入剪贴板，并使用终端粘贴操作。OSC 52
无法确认终端是否接收。

## 查找进阶任务

- 通过 `/instructions` [查看提示词](maybecode-instructions.md)。
- [创建 Session 分支或查看修改](git-workspaces.md)。
- [核查中断后的工具结果](recovery.md)。
- [配置子 Agent](subagent-delegation.md)或[运行团队任务](maybecode-team.md)。
- [选择 Context 行为](../concepts/context-and-history.md)及[设置 Run 预算](run-budgets.md)。
