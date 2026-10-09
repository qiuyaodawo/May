# 使用共享 Web UI

[English](../../en/guides/web-ui.md) | **简体中文**

浏览器工作台支持发送消息、阅读历史、处理审批和管理产品资源。MaybeCode 与
MaybeClaw 共享浏览器组件和传输方式，宿主负责执行、权限和持久化。

MaybeCode 需要已经配置的模型和编码工作区。MaybeClaw 需要本地管理员账户及
Agent 配置，首次启动流程可以创建这些内容。下文仓库命令在根目录执行，使用
`package.json` 声明的 pnpm 版本。

## 启动

### 打开已有 MaybeCode 工作区

1. 在任一种 MaybeCode 终端界面输入 `/web`。
2. 命令选择本地回环端口，在默认浏览器打开当前工作区和 Session，页面自动连接。
3. 刷新或断开页面后，重新执行 `/web`。
4. 关闭页面只断开连接；退出终端时同时关闭 Agent 和 Web 服务。

终端与 Web 分别接收实时事件，共享一个 controller。在任一界面发送消息、完成
审批、切换模型或 Session，两个界面都会更新。MCP 交互可以在任一界面回答，
完成后全部已连接界面移除对应请求。

启动 URL 的 fragment 包含一次性连接凭据。页面移除 fragment，再兑换控制令牌。
连接凭据有效期为 60 秒，只能使用一次，同时最多八个等待兑换的凭据。控制令牌
仅保存在页面内存，全部请求仍经过认证和 Origin 检查。

### 独立启动 MaybeCode Web 宿主

1. 使用已有 May 模型配置。在 PowerShell 生成令牌，复制到剪贴板用于连接，再
   启动宿主：

```powershell
$env:MAYBECODE_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
Set-Clipboard $env:MAYBECODE_CONTROL_TOKEN
pnpm maybecode --ui web --port 3940
```

2. 打开显示的地址，选择**连接本地服务**，粘贴令牌。连接后清理剪贴板。
   页面刷新后需要重新连接。
3. 使用 Ctrl+C 停止宿主。完成后清理启动 shell 中的令牌：

```powershell
Set-Clipboard -Value ""
Remove-Item Env:\MAYBECODE_CONTROL_TOKEN
```

`--continue` 和 `--resume` 按照终端方式选择 Session 历史。`--port` 需要
`--ui web`，`0` 选择可用端口。默认界面为 `retained` TUI。令牌不保存到浏览器
存储或静态资源。

### 启动 MaybeClaw

```powershell
pnpm maybeclaw
```

命令启动本地服务并打开默认浏览器。缺少配置或管理员认证时，完成本地密码
初始化。该流程保留已有 May 配置，保存密码哈希。登录后选择**Agent 管理** →
**添加 Agent**，随后创建 Session。

`--no-open` 或 `serve` 子命令只启动服务。需要初始化时，打开终端显示的本地
HTML 文件。Ctrl+C 停止服务，修改密码使已有登录失效。密码要求、登录有效期
和远程 CLI 认证参阅[MaybeClaw 指南](maybeclaw.md)。

## MaybeCode 命令与交互

输入框使用终端的斜杠命令注册表。上下方向键选择补全项，Tab 填入内容。未知
命令和无效参数显示错误。管理输出保存在页面内存中，不进入对话历史。

| 任务 | Web 入口 |
| --- | --- |
| 选择模型和默认 profile | 模型下拉菜单；`/model`；`/model profile --default` |
| 选择 reasoning effort | Effort 下拉菜单；`/effort`；`/effort default` |
| 管理 Session | 侧栏；`/new`、`/resume [id]`；重命名和确认删除 |
| 重试和检查执行 | `/retry`、`/instructions`、`/status`、`/context` |
| 管理目标 | `/goal start`、`status`、`pause`、`resume`、`cancel` |
| 压缩 Context | `/compact [history-reference\|provider-native]` 或压缩按钮 |
| 使用 Skills | `/skills`、`/skills show name`、`/skills use name [task]` |
| 使用 MCP | `/mcp` 的目录、资源、提示模板、订阅和任务命令 |
| 调查恢复 | `/recovery`、`/recovery resolve id finding` |
| 阅读详情 | `/details`、`/thinking`、历史搜索和详情面板 |
| 退出宿主 | `/quit` 或 `/exit`，随后确认 |

普通消息取消当前执行，等待取消结束，再启动新请求。`/steer <message>` 按接收
顺序保存输入，在下一个完整 Step 边界交付，等待其中的工具和审批结束；空闲时
启动 Run。`/stop` 和取消按钮终止当前操作及等待输入，已经取消的输入需要重新
发送。已交付内容显示一次，重新打开 Session 后继续保留。

MCP 表单和可编辑审阅显示准备提交的 JSON，要求确认。URL 请求需要同意、
手动访问和明确的重试操作。命令等待期间仍可回答交互或取消。Broker 检查 schema、
归属及过期时间，答案不进入历史。独立 Web 同样启用 broker。`team` 和
`mcp login` 保留独立 CLI 入口，参阅[MCP 交互](mcp.md#有作用域的用户交互现代-mrtr)。

## Session 分支与文件版本

工作区宿主在顶部显示当前 Git branch，detached HEAD 显示简短 commit hash。
历史回复保留当时 branch 和 commit，外部 Git 变化和 Session 切换更新当前信息。

在完整回复后选择**创建分支**，选择工作区模式。当前工作区保留已有文件，新建
worktree 从回复关联的 commit 开始。创建会话分支需要可恢复的 Session 状态；
创建 worktree 还需要文件版本。执行中的消息不能作为选择位置。

**本轮文件变化**显示该回复的差异，顶部**查看文件变化**提供整个 Session 和
当前工作区比较。新增、修改、删除和二进制文件具有明确状态，文本 diff 支持搜索
和修改位置导航。未提交内容显示为当前工作区变化。

恢复文件时选择**预览恢复**，阅读差异，再选择**确认恢复文件**。预览之后人工
修改文件会产生冲突并阻止恢复。**管理 worktree**提供已登记路径、branch、起点
commit 和打开、删除操作。删除目录前检查关联 Session、进程、未提交修改和
未合并 commit。

TUI 通过 `/fork` 和 `/changes` 提供相同任务。`/fork` 中使用方向键导航、`/`
搜索、Space 预览、Enter 选择、Escape 取消。Diff 中 Page Up/Down 滚动、`/`
搜索、`N` 查找下一处、`]` 选择下一处修改、`R` 预览恢复、`Y` 确认。

自定义宿主提供可选 `workspace`、`forkPoints`、`checkpoints` 和 `worktrees`
快照字段。操作使用 `session.fork`、`changes.view`、`worktree.open`、
`worktree.delete`、`changes.restore.preview` 和 `changes.restore.apply`。
`UiWorkspaceDiff.restorePreviewId` 标识宿主保存的预览。控件只在宿主提供
对应能力时显示。

## 阅读历史与详情

对话按 Run 分组，显示工具数量、审批和异常状态。展开、收起和异常过滤只影响
当前视图，审批入口保持可用。新输出保留当前历史阅读位置，并提供
**有新内容 / 回到最新**。

**查看详情**打开侧栏，显示概览、输入、输出、错误和展示字段。只读字段支持
前后内容与刷新。宿主将内容绑定到资源和版本 hash，拒绝混合不同版本读取。
概览可以使用产品 Diff 组件，超长展示 JSON 按原始文本分段读取。

侧栏搜索全部 Session 标题或任务提示词，按照创建时间和稳定 ID 分页。资源新增、
删除或重命名后刷新已加载页面，保留搜索条件与页数。`snapshot.resourcesVersion`
允许宿主报告整个目录的变化；未提供时，根据快照中的资源 ID 和标题变化刷新。

**搜索内容**查询已保存的用户及助手文本、reasoning、工具输入结果、诊断和展示
内容，包括超过预览上限的部分。结果为匹配记录，再次搜索时刷新。读取旧页面
保留当前审批，不激活其他 Session。

自定义宿主声明 `snapshot.reads` 和可选 `UiHost.resources`、`history`、`field`。
认证接口 `/api/ui/resources`、`/api/ui/history`、`/api/ui/field` 要求当前
`hostId`，后两者还要求 `selected`。页面接受 `query` 和不透明 `cursor`，最多
50 条记录，传输目标约 256K 字符；单条具有大小限制的大记录可能超过该目标。
游标绑定宿主、资源、查询及位置，位置被删除或范围变化时需要重新搜索。
旧宿主或旧选择的响应被丢弃。

`AgentWorkspace.readSessionHistory()` 检查目录归属并调用 `SessionStore.inspect()`。
读取不激活运行时、不更新最近使用时间、不修复日志。文件存储忽略未完成的尾部
字节，拒绝损坏的完整记录。自定义存储需要提供安全检查，MaybeClaw 还验证任务
归属。当前在内存中扫描目录及日志，大型历史和已加载页面会消耗 CPU 与内存。

## 执行证据与审批

工具卡片显示等待审批、运行中、完成、失败、拒绝、未执行和结果未知。已经开始
却没有确认结果的工具在取消后仍为结果未知。宿主恢复证据可以证明未执行。
部分助手回复标记为中断。进度用于实时显示，完成证据另外持久保存。

只有当前 `snapshot.interactions` 提供审批控件。历史审批证据只读，宿主拒绝
过期或不可用选项。本会话审批要求授权键；输入被截断时只能拒绝。

持久审批需要宿主提供范围说明和操作人员身份。`ApplicationUiHost.permissionActor()`
提供身份，客户端不能提交身份。可选 `permissionRules: { list, revoke, create? }`
实现 `permission.rules.list`、`revoke` 和 `create`。创建请求提供已有可见规则
ID 及允许或禁止决定，宿主生成完整范围和操作人员身份。确认显示完整范围及禁止
优先规则。`UiPanel.actions` 支持公共或产品详情面板中的操作。

## 模型与诊断

MaybeCode 模型面板显示已知、未知及不支持能力、来源、发现诊断与刷新。活动
Session 诊断使用可选 observability 插件。MaybeClaw 提供 `agent.check` 和
`session.diagnostics`，同样检查认证与 Session 归属。

`@may/ui-client.createTelemetryPanel(data)` 最多显示 40 条记录，包含每项独立
耗时、状态、父级身份、采样及保留范围。宿主可以单独查询其他诊断页面，参阅
[模型与遥测集成](model-telemetry-integration.md)。

## 接入自定义宿主

| Package 或层次 | 职责 |
| --- | --- |
| Application 与产品宿主 | 执行、权限、预算、持久化、恢复 |
| `@may/ui-client` | JSON 类型，浏览器连接与状态同步 |
| `@may/ui-client/application` | 单活动 Session 工作区适配器 |
| `@may/ui-client/server` | 本地 HTTP、认证、Origin 检查、操作结果记录和 SSE |
| `@may/web-ui` | 工作台及对话、输入、审批、详情组件 |
| 产品扩展 | 文件差异、任务生命周期、投递及产品展示 |

实现 `UiHost`，或者将 `ApplicationUiHost` 接入 `AgentWorkspaceController`。
浏览器使用适合浏览器的导出，Node 适配器由宿主使用。静态模块通过固定资源表提供。

终端管理执行时，向 `ApplicationUiHost` 提供独立 `events` 和
`closeApplication: false`。终端负责分发事件和关闭 controller。组合
`startUiServer({ browserLogin: true, ... })` 与
`webUiAssets(..., { browserLogin: true })`，通过 `createLoginUrl()` 创建连接凭据。
产品路由可以使用 `@may/ui-client/server` 的 `BrowserLogin`，调用 `issue()`、
`redeem()` 和 `clear()`。自定义页面可向 `mountWebUI` 提供 `initialToken` 与
`connectionHint`，由启动程序提供连接说明。

提供 `snapshot.controls` 的宿主，在所选资源具有活动操作或等待交互时将 `busy`
设置为 `true`。活动操作或客户端命令等待期间，如果 `commands` 包含
`controls.cancelCommand`，工作台显示取消按钮。空闲时显示发送按钮；Enter
提交，Shift+Enter 换行。斜杠命令要求 `controls.inputCommand` 可用，普通消息
要求 `message.submit` 可用，新任务要求 `task.submit` 可用。运行期间输入
宿主支持的内容时，同时显示发送和取消按钮。当前客户端命令结束后，才能再次
通过输入框提交。MaybeCode 包含 Run、Context 压缩和 MCP 交互；MaybeClaw
包含所选 Session 的 queued、running、waiting 和 cancelling 任务。

`ApplicationUiHost` 支持 `controls`、`complete`、`available`、`submit`、
`concurrentCommands` 和 `interactionCommands`。命令等待期间，交互响应通过
独立检查的通道处理。产品验证可用性和归属。`UiReceipt.output` 提供临时命令输出，
`disconnect` 关闭请求页面。`UiClient.interact()` 可以在 `command()` 等待期间
执行。服务端发送退出结果后调用 `exit`，提供 `closed`；未提供回调时关闭宿主。

可信 `WebUiExtensions` 注册 `tools[toolName]`、`approvalDetails[toolName]`、
`diagnostics[code]`、`presentations[kind][version]` 和 `panels[id]`，返回
HTMLElement 或 null，保留公共证据与审批控件。未知类型或版本、null 和扩展失败
保留公共显示。模型输出不能加载扩展代码。预览接口的客户端、宿主和产品扩展
需要一起升级。

`WebUiOptions.navigation` 或 `createNavigation()` 提供带类型的导航分组，支持
图标、名称、标题、徽标、动作和禁用状态；`onNew` 与 `newLabel` 定制创建操作。
`max-width: 760px` 时使用覆盖面板，隐藏面板具有 `inert` 与 `aria-hidden`。
Escape 或遮罩关闭面板，焦点返回按钮；Tab/Shift+Tab 在开放面板内循环。
主题跟随系统，当前浏览器界面使用中文。

## 协议 v1 与限制

| 接口 | 用途 |
| --- | --- |
| `GET /api/ui/snapshot?selected=<id>` | 能力、资源、当前对话、交互和面板 |
| `GET /api/ui/events` | 认证 SSE 失效通知 |
| `POST /api/ui/commands` | `{ version, hostId, requestId, name, targetId, expectedActiveId?, args }` |
| `GET /api/ui/complete` | 绑定宿主和 Session 的认证补全 |

连接、失效通知和重连时重新读取快照。两秒心跳观察其他执行者，实时变化按
120 ms 合并。慢事件连接会关闭，客户端等待后重连。旧响应不能覆盖新状态，
SSE 不提供持久事件重放。

命令不自动重试。宿主保存请求 ID 和内容，相同请求返回已有结果，内容冲突时
拒绝。累计 4,096 条结果后需要有序重启。重启改变 `hostId`，旧的结果未知请求
被拒绝。创建新请求前检查当前状态，去重记录仅在当前宿主生命周期内有效。

MaybeCode 全部页面显示一个活动 Session。新建、切换和删除要求执行空闲且没有
待处理 MCP 交互，携带 `expectedActiveId`，拒绝旧状态操作。当前 Session 无法
删除。任务宿主允许各页面独立浏览。MaybeClaw 提供最终结果、取消意图、证据恢复、
派发失败重试、渠道及最近 100 条投递记录；实时投影保留八个任务，已有 Session
日志提供重启后的历史工具结果。任务、验证和投递策略由产品负责。

服务监听 `127.0.0.1`，用于本地单操作者，保持本地访问。请求正文最多 256 KiB，
参数字符串最多 65,536 字符。快照最多 50 个近期记录，预览约 64K 字符，字段
每段 32,768 字符。Provider continuation state 保持私有，工具详情属于经过认证
的敏感工作区数据。尚无文件浏览或产物下载。

Markdown 支持文本、标题、列表、引用、代码、表格、强调和 HTTP(S) 链接。
原始 HTML、远程图片、生成脚本及可执行预览关闭。恢复使用当前执行所有者，
每个 Session 由一个运行时管理。

## 验证

`pnpm build` 后，通过实际工作区、目录、UI 宿主和 HTTP 服务执行本地浏览器测试：

```powershell
pnpm --filter @may/web-ui exec playwright install chromium
pnpm --filter @may/web-ui test:browser
```

这些检查包含资源分页与搜索、新增、删除、重命名、已加载页面状态及过期游标。
浏览器工作文件保存在被忽略的 `review/`。需要已配置 Provider 的检查具有以下要求：

| 检查 | 必需环境与命令 |
| --- | --- |
| MaybeCode 控制及终端/Web 共享 | `MAYBECODE_WEB_LIVE=1`；`pnpm --filter @may/maybecode exec node --test test/integration/web-controls.test.mjs test/integration/web-terminal.test.mjs` |
| 工作区文件版本 | `MAY_LIVE_PROVIDER_UI_TESTS=1`；`node --test packages/ui/web/test/browser/workspace-versions.test.mjs` |
| Session 分支与隔离测试提交 | `MAY_LIVE_PROVIDER_UI_TESTS=1` 和 `MAY_GIT_CHECKPOINT_TEST_COMMITS=1`；`node --test packages/ui/web/test/browser/workspace-session-fork.test.mjs` |

工作区文件版本检查初始化配置的 Model 并检查 Git 和页面；发送消息的检查使用
已配置凭据并消耗 Provider 配额。工作区检查要求配置
`deepseek-v4-flash` profile。提交标志仅授权独立测试仓库与 worktree 的提交。
缺少必需标志时测试跳过。实际执行、布局、外部投递及恢复需要分别报告，单项
本地测试通过不代表已经验证全部行为。
