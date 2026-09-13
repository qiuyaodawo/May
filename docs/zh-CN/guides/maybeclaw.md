# MaybeClaw：本地持久任务

[English](../../en/guides/maybeclaw.md) | **简体中文**

MaybeClaw 是与 MaybeCode 并列、基于 May 构建的第二款应用。通过 CLI、Web UI、
飞书与 Telegram 提供有界、持久化的本地任务，面向单用户、可信本地宿主。数据目录不是多租户隔离
边界；本轮也没有提取新的通用任务框架。

## 启动与提交

先在常规 May 配置中配置 Provider 和模型档案，再从仓库运行。根脚本会先构建工作区。

```powershell
pnpm maybeclaw --help
pnpm maybeclaw task submit "总结 notes.txt 并引用依据。" --request-id notes-1 --read-directory C:\work\notes
```

`submit` 先持久化任务，输出完整的 64 位十六进制任务 ID，默认随后在前台执行并输出
最终快照。Ctrl+C 或 SIGTERM 请求取消。退出该进程不等于分离后台执行；需要持续
消费队列时，使用下文的 `serve` 常驻服务。

只入队、不立即执行：

```powershell
pnpm maybeclaw task submit "解释这些需求。" --request-id requirements-1 --enqueue
pnpm maybeclaw task list
pnpm maybeclaw task run <id>
pnpm maybeclaw task status <id>
pnpm maybeclaw task result <id>
```

将 `<id>` 替换为输出的完整 ID。`--enqueue` 加载并验证模型配置，但不创建或调用
模型。`task run` 只启动有证据表明尚未提交输入的排队任务；终态任务直接返回已保存
快照。同一任务只允许一个执行所有者，不同任务可以在不同进程执行。服务端并发上限
不限制另行启动的前台 CLI；当前没有全局每日总额度服务。

`--request-id` 可省略，省略时生成 UUID。响应丢失后，使用已知的相同键重复提交。
键的作用域是整个数据目录。相同键和任务规格返回原任务，不再次启动，即使仍是
排队状态。相同键但输入、读取范围、模型绑定或预算变化会被拒绝。同时创建可能返回
锁错误，应使用同一个键重试，不能换键绕过。自动生成键的响应丢失后，可通过
`task list` 和 `task status` 查找。

## 常驻服务与 Web UI

使用 PowerShell 7 生成控制令牌，然后保持服务进程运行：

```powershell
$env:MAYBECLAW_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
pnpm maybeclaw serve --port 3939
```

打开 `http://127.0.0.1:3939`，在登录表单粘贴该环境变量的值。可在本机使用
`$env:MAYBECLAW_CONTROL_TOKEN | Set-Clipboard` 复制，粘贴后清理剪贴板。
不要把令牌放入 URL、仓库或聊天消息；服务不会打印它。
`--token-env <name>` 可指定其他环境变量名；令牌必须是 32..256 个可打印、非空白
ASCII 字符。应使用随机值，而不是容易记忆的口令。

Web UI 提供任务提交、轮询状态、完整文本结果、取消、证据恢复、派发失败重试、
渠道状态和最近 100 条回传记录。每次提交都是独立任务，不是共享对话中的一轮。
尚无逐 token 流式渲染。令牌只保存在页面内存，刷新后需要重新登录。
模型输出一律按纯文本显示，不执行 HTML、不渲染 Markdown。

服务**仅监听 127.0.0.1**，每个 API 请求都要求 Bearer 鉴权，检查 Host/Origin，
并设置严格 CSP。控制令牌可访问**全部任务**，不是分发给聊天用户的个人凭据。
不要通过隧道或反向代理暴露本服务，也不要将其作为多租户服务。

`serve` 支持 `--config`、`--model`、`--read-directory`、`--data-directory`。
Web/渠道新任务只能使用宿主选择的模型和读取范围；客户端不能指定路径、工具或预算。
授权读取目录也等于向**所有白名单聊天用户**开放该目录，应只允许可信用户。
此前由独立 CLI 入队的任务保留原来显式授权的规格。

服务按创建时间消费队列，`server.maxConcurrent` 默认为 1，支持 1..4。
服务接收新任务时最多允许 100 个待执行任务。关闭浏览器或 CLI 客户端不取消任务。
Ctrl+C/SIGTERM 停止服务时，会停止接收消息、请求取消正在运行的任务并刷新日志；
尚未派发的任务保持排队，下次启动继续处理。这是常驻进程，**不是自动安装的
Windows/systemd 系统服务**，也不是定时调度器。需要开机自启时另行配置 OS 进程管理。

派发前配置错误会使任务保持排队，并显示在 Web UI；修复后点击“重试调度”。
该操作不会授权重放已提交输入。收件箱处理失败会保留稳定事件 ID、在健康状态中提示，
仅在重启服务后重试。

`host.lock` 独占渠道日志与队列进程，任务仍使用各自的锁。异常退出后，应读取锁的
PID/主机名，确认旧所有者已停止，才能手动删除那一个遗留锁。不得自动抢锁或删除
执行证据来强制重新开始。

## 聊天渠道

将以下片段合并进现有 May 配置，保留原来的 providers/models，并替换示例应用/用户 ID。
两个渠道默认关闭，仅 `enabled: true` 时启用；启用时 `allowUsers` 必须非空。

```json
{
  "apps": {
    "maybeclaw": {
      "server": { "maxConcurrent": 1 },
      "channels": {
        "telegram": {
          "enabled": true,
          "botTokenEnv": "MAYBECLAW_TELEGRAM_TOKEN",
          "allowUsers": ["123456789"]
        },
        "feishu": {
          "enabled": true,
          "appId": "cli_0123456789abcdef",
          "appSecretEnv": "MAYBECLAW_FEISHU_SECRET",
          "allowUsers": ["ou_replace_with_your_open_id"]
        }
      }
    }
  }
}
```

如果希望直接填写凭据，将 `botTokenEnv` 替换为 `botToken`，飞书则将
`appSecretEnv` 替换为 `appSecret`，值填写真实凭据。例如 Telegram 对象可写为：

```json
{
  "enabled": true,
  "botToken": "123456789:REPLACE_WITH_YOUR_REAL_BOT_TOKEN",
  "allowUsers": ["123456789"]
}
```

每一对直接值/环境变量名字段只能选一种。不要将 Token 填入 `botTokenEnv`，它只接受
变量名；两者都省略时使用默认环境变量。直接填写的密钥以明文保存在配置文件中，
应限制文件访问权限，不要提交/分享，也不要将配置文件放入 Agent 可读取的目录。
凭据不写入任务规格、健康状态或正常启动日志。Web UI 控制令牌仍通过环境变量设置，
此次直接填写选项仅适用于聊天渠道凭据。

如果使用前面的环境变量配置，在启动服务的同一个 PowerShell 7 进程设置凭据
（已直接填写凭据的渠道可以跳过）：

```powershell
$env:MAYBECLAW_TELEGRAM_TOKEN = Read-Host -MaskInput "Telegram Bot Token"
$env:MAYBECLAW_FEISHU_SECRET = Read-Host -MaskInput "Feishu App Secret"
pnpm maybeclaw serve --config C:\work\may.config.json
```

**Telegram：**通过 [BotFather](https://t.me/BotFather) 创建机器人，取得 Bot Token，
将自己的数字用户 ID 以字符串写入白名单，不能填写用户名。可以在 MaybeClaw 停止时，
从自己机器人 `getUpdates` 返回的私聊消息 `message.from.id` 取得 ID；不要将 Token
交给第三方 ID 查询网站。适配使用 [Bot API 长轮询](https://core.telegram.org/bots/api#getupdates)，
先持久化消息与 offset，再推进确认；忽略群聊、编辑消息和非文本事件。
已有 webhook 时显示 `webhook-conflict`，不会擅自删除其他接收端的配置。
每个机器人只运行一个接收端。本机必须能访问 `api.telegram.org`；没有内置代理配置。
鉴权或轮询冲突会停止该接收端；临时读取失败有退避，并遵守 Telegram 返回的重试等待时间。

**飞书：**在[开发者后台](https://open.feishu.cn/app/)创建企业自建应用，启用机器人，
取得 App ID / App Secret。按平台的[接收消息](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
和[发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create)说明授予接收机器人
私聊消息、以机器人身份发消息的权限。先启动服务，再选择长连接事件接收方式，订阅
`im.message.receive_v1`，发布应用并授权目标用户使用。白名单填写应用范围内的
**open_id**（`ou_...`），通过平台 API 调试/事件工具获取，不能填显示名称。
变更配置后重启服务。[官方 Node SDK](https://github.com/larksuite/node-sdk)负责鉴权长连接
及重连协议；处理器只等待消息持久化，不等待模型执行。此适配面向国内飞书
`open.feishu.cn`，不支持国际 Lark 或应用商店应用。

两个渠道都只支持私聊文本。普通文本创建任务，`/start`、`/help` 返回帮助。
`/status <id>`、`/result <id>`、`/cancel <id>` 只能操作该发送者在同一机器人、
同一私聊中创建的任务，ID 必须完整 64 位。暂不支持群聊、附件、交互卡片和多轮记忆。
不支持的事件或未授权输入直接忽略；输入文本上限 16,384 字符。

持久发件箱分别发送接收通知和任务终态结果。回复为有界纯文本；较长结果会截断，
完整结果在操作员 Web UI 中查看。每次网络发送前先落盘发送意图。发送异常、未确认
或意图落盘后崩溃，都标记为 `unknown`，**不会自动重发**，即使飞书请求包含 UUID。
这是优先避免重复副作用，不保证最终送达，也不是 exactly-once 消息系统。
在原私聊再次发送 `/result <id>`，即明确请求一条新回复。移出白名单用户的待发消息
会被抑制；更换机器人身份不会通过新机器人发送旧结果；禁用渠道会保留待处理数据。
接收端连接成功不等于事件订阅/发送权限已验证。缺失凭据显示 `credential-error`，
不影响使用本地 Web UI。

## 控制 API

全部端点要求 `Authorization: Bearer <控制令牌>`，修改操作要求
`Content-Type: application/json`，不接受 Cookie 或查询字符串令牌。

| 方法/路径 | 含义 |
| --- | --- |
| GET `/api/health` | 宿主/渠道状态、调度/收件错误、回传元数据 |
| GET `/api/tasks` | 持久任务列表 |
| POST `/api/tasks` | `{ "prompt": "...", "requestId": "stable-key" }`，新任务 202，重复请求 200 |
| GET `/api/tasks/<id>` | 任务、取消意图和所有者/证据元数据 |
| POST `/api/tasks/<id>/cancel` | `{}`，持久取消请求 |
| POST `/api/tasks/<id>/recover` | `{}`，核对证据，不重放 |
| POST `/api/tasks/<id>/dispatch` | `{}`，清除派发前错误，让排队任务重新参与调度 |

CLI 可使用同一个后台，不需要读取模型凭据：

```powershell
pnpm maybeclaw task submit "解释这些需求。" --request-id web-1 --server http://127.0.0.1:3939
pnpm maybeclaw task list --server http://127.0.0.1:3939
pnpm maybeclaw task result <id> --server http://127.0.0.1:3939
```

`--server` 拒绝本地 config/model/read/data-directory/enqueue 覆盖。
客户端 `task run` 请求异步调度，不等待终态。服务运行时优先使用 `--server`；
独立前台命令会竞争任务所有权，且不受宿主并发上限约束。API 请求 ID 使用 `api:` 命名空间，
渠道事件使用 `channel:` 命名空间，与独立 CLI 请求分开。API 重复提交保留原模型、
范围和预算；修改提示文本会被视为冲突。

## 配置与权限

提交支持 `--config <path>`、`--model <profile>`、`--read-directory <path>`。
所有命令支持 `--data-directory <path>`，默认 `~/.may/maybeclaw`；后续命令必须
使用相同数据目录。

不提供读取目录时，Agent 没有任何工具。显式目录只授予现有、受工作区范围限制的
`read` 工具：单文件最多 256 KiB，单次最多 200 行，可通过 offset/limit 分段读取。
沿用 coding-tools 的路径与符号链接边界检查，默认允许读取硬链接，没有任意文件发现工具。
读取目录和任务数据目录不能在任何方向相互包含；读取目录先规范化，执行前再次检查。

这属于读取权限边界，不是 OS 沙箱。没有自动秘密文件过滤：授权目录可能包含敏感
文本，并被发送给模型 Provider、写入持久历史。不要授权整个主目录或凭据目录，应
使用专用输入目录。读取的是实时文件，不是不可变快照。文档属于数据，不是可信指令。
MaybeClaw 不加载 MaybeCode 的项目指令、MCP 配置或 Skills。

通过模型档案及 adapter、端点、模型、选项和限制的摘要固定配置。任务记录不包含
Provider 密钥或原始模型选项值。可以轮换凭据，但修改已绑定模型配置会在派发前阻止
执行；应恢复原配置，或审查新配置后提交新任务。状态、结果、列表、恢复及返回已终结
任务都不加载凭据或调用模型。

默认每次 Run 限制 12 步/模型调用、24 次工具调用、3 分钟、131,072 总 token。
配置模型每次输出最多 4,096 token，或更小的档案限制。禁用自动原生压缩。
token 限制在响应边界检查，不是 Provider 费用预留；模型不提供必要用量时会以
`RUN_BUDGET_USAGE_UNAVAILABLE` 失败。

在现有配置中加入以下应用设置可收紧限制：

```json
{
  "apps": {
    "maybeclaw": {
      "runBudget": {
        "maxDurationMs": 60000,
        "maxModelCalls": 6,
        "maxTotalTokens": 65536
      }
    }
  }
}
```

这只是配置片段，不是完整的 Provider 配置。覆盖只能收紧默认值。任务保存接收时的
预算；宿主之后进一步收紧预算，会阻止旧排队任务，而不是静默保留较宽限制。
没有逐任务 CLI 预算覆盖。

## 取消、状态与恢复

```powershell
pnpm maybeclaw task cancel <id>
pnpm maybeclaw task recover <id>
```

取消先持久化意图。运行中的所有者轮询消费；空闲且尚未提交输入的任务可以立即转为
`cancelled`。取消无法撤销 Provider 调用，也不能证明外部操作未发生。已完成任务保留
结果；执行结果未知的任务即使请求取消，仍保持 `blocked`。

`status` 返回最近持久快照、取消意图、所有者锁信息和私密 Session 证据路径，不修复
日志、不连接 Provider、不接管执行。崩溃后可能仍显示过时的 `running`。
`recover` 获得所有权后核对 Session 并更新投影，不启动模型、不重放输入：

| 证据 | 恢复行为 |
| --- | --- |
| 排队任务，尚无 Session/输入 | 保持排队，或根据取消请求结束 |
| 匹配的 Session 已建立、尚无输入 | 可安全返回排队 |
| 匹配的持久 Run 终态 | 恢复完成、失败或取消状态 |
| 输入已提交、没有终态结果 | 阻塞，绝不自动重新提交 |
| 已有执行意图、Session 丢失 | 阻塞；缺失证据不等于允许重试 |
| 完整记录冲突或损坏 | 拒绝恢复并保留证据 |

每个任务投影日志上限 8 MiB。只有最后一条未换行结束的记录能在写锁保护下丢弃；
只读查询忽略该尾部但不截断文件。Session 存储沿用 May 的恢复规则。
写入在确认前执行 sync，但不保证抵抗文件系统回滚、硬件丢失或所有断电场景。

不自动抢占遗留锁。进程崩溃后，根据 `status` 中的 PID 和主机名确认旧进程已停止，
然后才能手动删除该任务的精确 `.lock` 文件，再执行 `recover`。不能删除任务或
Session 日志来强制重试。本预览没有按 PID 自动解锁、核实审批 UI 或已提交任务重试。
先调查阻塞证据，再明确判断能否建立新任务；换一个请求 ID 并不能证明重复操作安全。

## 结果语义与存储

执行状态为 `queued`、`running`、`completed`、`failed`、`cancelled`、`blocked`。
`completed` 仅表示持久的 Agent 最终回答已经产生，不表示内容正确或业务目标经过独立
验证。所有快照均为 `verification: "unverified"`。投递状态单独记录：终端打印或渠道
回传失败不会重新执行任务，可以通过 `result` 再取已保存文本。输出使用 JSON 编码，不将模型
文本解释为终端控制序列。

退出码：查询成功、接受提交/取消、排队或完成快照为 `0`；结果不可用、操作错误以及
失败/取消/阻塞执行为 `1`；CLI 语法错误为 `2`。重复提交属于接受原任务查询，即使
旧任务失败也返回 `0`，应检查返回状态。派发前的配置或访问错误使任务保持排队。
查询成功不等于任务成功。

数据目录中的私密文件：

```text
tasks/<id>.jsonl     任务规格与状态/结果投影
tasks/<id>.lock      本地独占执行所有者
tasks/<id>.cancel    单调的取消意图
sessions/           May FileSessionStore 执行证据
host.lock           本地常驻服务独占所有者
channels.jsonl      消息身份/归属、Telegram 游标及外发证据
```

任务日志负责接收输入与宿主状态，Session 日志负责执行结果。不存在跨文件事务，
通过稳定的任务/输入身份和证据核对处理交接。此版本每个任务拥有一个 Session，最多
提交一次输入。数据是宿主私有的明文状态，不是加密或多租户存储。日志可能包含
提示、文件内容、回答和 Provider 错误详情；保留期、备份及目录访问控制由宿主负责。

渠道日志上限 32 MiB，接收时最多容纳 100 个未处理收件事件。尚无日志自动压缩或
保留期管理；达到上限后停止新的持久接收。应保留日志/游标、明确规划迁移，不要删除
去重证据。私密文件模式仅尽力设置；Windows 上应使用账户级 ACL 保护目录。

## 架构与后续范围

产品 API 为 `MaybeClaw.submit/run/status/cancel/recover`，`FileTaskStore` 还支持列表。
`TaskSpec` 与本地日志不依赖 CLI 或渠道载荷。`loadModel` 是可信宿主回调；非 CLI
宿主必须自行执行配置及预算策略。MaybeClaw 直接组合 `defineAgent`、
`AgentApplication`、`FileSessionStore`、Provider 选择与读取工具，不依赖
`apps/maybecode`。

`MaybeClawHost` 管理有界队列，`startControlServer` 提供传输与操作员鉴权，
`ChannelHub` 将已验证的渠道身份/消息映射为任务，并通过 `ChannelStore` 持久化回传。
Telegram/飞书适配器只在边缘转换平台消息；CLI、Web 与渠道共用任务服务。
产品策略保留在 `apps/maybeclaw`，不向 May Core 塞入平台 SDK 代码。

尚未包含：连续 Conversation 路由、保证最终送达的 Outbox、定时任务、
持久用户审批/等待、长期记忆、MCP、Skills、多 Agent 委派、
编码修改、沙箱或全局预算。先用实际任务稳定契约，再提取 `@may/tasks`，不把渠道策略
塞入 Core。

## 验证

```powershell
pnpm --filter @may/maybeclaw test
pnpm docs:check
```

聚焦离线测试覆盖工具执行与重复输入、取消与竞争所有者、真实子进程终止、不完整及
损坏日志、不重放恢复、模型/预算绑定，以及连接本地确定性服务的真实 HTTP Provider
适配器。这些属于工程检查，不是真实模型质量或 benchmark 结果。
新增聚焦用例覆盖真实回环 HTTP 服务、API 鉴权/Host/Origin、并发、正常退出与重启、
渠道归属/去重、发送未知状态恢复，以及两个适配器的模拟平台协议。浏览器流程使用
固定本地模型验收。未提供真实平台凭据时，这些测试**不能证明**飞书/TG 真实事件订阅或投递成功。

## 日志维护

任务日志在累计快照达到 8 MiB 上限前写入完整状态检查点；通道日志在 32 MiB 上限前
合并同一记录的多个版本。收件身份、投递回执和未知效果都会保留，合并不会重发投递。
不同记录仍占用空间；当前状态本身达到上限时，需要停止宿主后归档。检查点要求当前读取器。
库调用方通过 `runMaybeClaw` 启动 serve 时，必须传入 `dependencies.signal` 以便显式关闭。

本地 request key 最多 128 字符；HTTP API 在添加 `api:` 命名空间前最多接受 100 字符，
使用 `--server` 时应遵守该上限。两者是不同的幂等命名空间，不能交换任务身份。
