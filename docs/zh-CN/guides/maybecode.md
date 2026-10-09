# 使用 MaybeCode

[English](../../en/guides/maybecode.md) | **简体中文**

通过终端或浏览器使用编码 Agent。按照[仓库开发指南](repository-development.md)
准备仓库，并依据[配置参考](../reference/configuration.md)设置 Provider 和模型配置。
应用使用所选模型的 API，并在启动目录中执行工作。

通过 `MaybeCodeApplicationOptions.tools` 提供的自定义工具注册到应用工具目录。
运行指令使用同一个目录描述当前环境。

## 启动应用

在 May 仓库根目录执行：

```bash
pnpm maybecode
```

该命令构建后启动应用。浏览器界面按照 [WebUI 步骤](web-ui.md)生成
`MAYBECODE_CONTROL_TOKEN`，然后执行 `pnpm maybecode --ui web`。
提交任务前核查显示的工作目录和模型。

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
执行 `pnpm remove --global @may/maybecode`。

## 控制工具审批

默认模式在执行命令或修改文件之前请求批准。`--yolo` 开启自动审批，`--no-yolo`
覆盖配置中的 YOLO 默认模式。通过 `/yolo on` 或 `/yolo off` 切换之前，暂停或取消
活动工作。`/yolo` 同样开启模式，`/yolo status` 查询状态。

终端和 WebUI 在开启期间显示 **YOLO · Auto-approve**。WebUI 还提供 **Permissions**
选择器。权限策略明确禁止的操作继续被拒绝。模式范围、重新启动行为、持久规则及
独立的团队授权见[权限模式](../reference/configuration.md#maybecode-权限模式)。

## 在 MaybeCode 执行期间发送消息

普通消息取消当前操作，等待取消完成后在同一 Session 开始新请求。`/steer <消息>`
等待当前 Step 及工具、审批完成后交付补充输入。消息保存后按照接收顺序交付。
空闲时启动 Run；完成或宿主让出执行权后仍待交付的输入，在当前操作结束后执行。

`/stop` 和 Web 取消按钮取消活动工作与待交付输入。终端没有选择文字时，`Ctrl+C`
执行相同操作。已取消的补充输入保留在历史中，需要重新提交才会执行。classic TUI、
retained TUI 和 WebUI 均支持这些操作。

## 查看 MaybeCode 对话

默认 retained TUI 在支持 xterm 鼠标报告的终端中提供滚轮浏览。每次事件滚动三行，
保留输入与焦点。向上滚动后保留阅读位置；返回底部后继续跟随新输出。

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
