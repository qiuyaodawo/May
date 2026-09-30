# MaybeClaw：Agent Gateway

[English](../../en/guides/maybeclaw.md) | **简体中文**

MaybeClaw 将 Agent 连接到持久会话、Web、CLI、Telegram 和飞书，管理路由、访问权限、
审批、执行与消息投递。

## 会话与配置

`pnpm maybeclaw --help` 和 `pnpm maybeclaw -h` 输出帮助内容并成功退出。
CLI 在加载运行模块、读取配置或初始化 SQLite 之前处理这些参数。

会话需要名称和一个或多个默认 Agent，可以填写聊天入口和免审批 Agent 名单。默认
Agent 自动进入名单。个人会话绑定一个平台身份；群聊会话绑定同一平台的群聊或话题。
每个 Agent 对话专属于一个 MaybeClaw 会话；同一种 Agent 可以通过不同对话 ID 服务
多个会话。Agent 对话按需创建。

在仓库根目录运行 `pnpm maybeclaw`。配置文件、MaybeClaw 配置或管理员认证缺失时，
本机初始化页面会要求设置并确认 10 至 1024 个字符的密码。服务自动写入 `version: 2`、
`agents: []` 和 Argon2id `passwordHash`，保留已有配置，然后在同一地址打开控制台。
登录后添加 Agent 并创建会话。新建配置文件还会包含空的 `providers` 对象。

初始化要求一次性凭据，程序会自动将其传入浏览器。使用 `--no-open` 或 `serve` 时，
打开终端显示的本机初始化 HTML 文件。该文件需要保密，初始化完成或正常关闭服务后
自动删除。刷新初始化页面会清除页面中的凭据，重新打开初始化文件可以继续操作。
初始化仅接受本机来源。已有有效配置直接启动；旧配置要求明确迁移；损坏配置会报错并
保持原文件。同一配置文件禁止并发初始化。如果进程被强制终止，需要确认进程已经停止，
再删除对应的 `<配置路径>.initialize.lock` 和遗留的 `*.initialize.html` 文件，重新启动。

手动配置时，保留 May 已有的 `providers`、`models`，合并以下内容：

```json
{
  "apps": {
    "maybeclaw": {
      "version": 2,
      "agents": [],
      "server": {
        "auth": {
          "password": "REPLACE_WITH_YOUR_OWN_PASSWORD"
        }
      }
    }
  }
}
```

启动 Web 控制台后，通过管理员密码登录，在 Agent 管理中添加首个 Agent，即可直接创建会话，无需重启服务。已有的 `providers` 与 `models` 配置继续保留供 May Agent 使用。

已预先登记 Agent 时的完整配置如下。将 `coding-profile` 和 `review-profile` 替换为已有模型配置名称。

```json
{
  "apps": {
    "maybeclaw": {
      "version": 2,
      "agents": [
        { "id": "code", "adapter": "may", "model": "coding-profile" },
        { "id": "reviewer", "adapter": "may", "model": "review-profile" }
      ],
      "server": { "maxConcurrent": 4, "idleMs": 600000, "shutdownMs": 30000, "approvalMs": 600000, "auth": { "password": "REPLACE_WITH_YOUR_OWN_PASSWORD" } },
      "access": { "sessionAdmins": {}, "creators": [], "deniedUsers": [], "allowedAgents": {} }
    }
  }
}
```

May Agent 支持 `model`、`instructions`、`readDirectory`、`permissions`、`runBudget`
和 `idleMs`。外部适配器声明创建、执行、查询、取消、补充输入、恢复、删除、审批、
协作与媒体能力。不支持的操作返回错误。`agent check <id>` 加载适配器并显示声明
能力；加载成功不能证明模型请求或者聊天投递已经成功。
Agent 状态区分 `unloaded`（尚未加载）、`loading`（正在加载）、`loaded`（已加载）、
`unavailable`（加载失败）、`releasing`（正在释放）、`reconfiguring`（正在更新配置）
和 `disabled`（已停用）。加载失败的状态持续显示，直到再次检查成功或者配置更新。
空闲释放后显示 `unloaded`，已经保存的对话仍然可以恢复。
后台处理发生未预期错误时，服务显示 `degraded`，向管理员提供错误原因并停止定时
处理。处理报告的问题后重新启动服务。

## 启动、Web 与 CLI

直接运行 `pnpm maybeclaw`，即可启动 Web 控制服务并在系统默认浏览器打开初始化
页面或登录页面，然后通过 Web 管理器创建会话。不填写子命令时，
同样支持 `--config`、`--port` 和 `--data-directory`。`--no-open` 用于只启动服务；
`serve` 也只启动服务。保持终端运行，按 Ctrl+C 停止服务。

```powershell
pnpm maybeclaw
pnpm maybeclaw --config may.config.json --port 3939
pnpm maybeclaw session create "项目评审" --agent code --allow-agent reviewer --config may.config.json
pnpm maybeclaw session list --config may.config.json
pnpm maybeclaw serve --config may.config.json --port 3939
```

手动配置密码时，在 `apps.maybeclaw.server.auth.password` 填写自己的管理员密码，
长度为 10 至 1024 个字符，空格会保留。启动时服务自动将这个字段转换为带随机盐的
Argon2id `passwordHash`。运行期间每隔 500 ms 检查配置保存，并在认证请求前检查。
修改密码时，在已有哈希旁增加 `password` 并保存，服务会删除明文字段、重新生成
哈希，并使已有登录及事件连接失效。服务停止期间保存的密码，在下次启动时转换。
文件转换无法删除编辑器历史或备份中的明文，需要另外保护这些文件。
认证配置无效时，管理请求会被拒绝，修正配置后可以重新登录。
服务只输出地址与渠道状态。默认数据目录为 `~/.may/maybeclaw`，可以通过
`--data-directory` 修改。

控制服务监听 `127.0.0.1`，对 API 执行身份验证，并检查 Host、Origin 和 CSP。
在 Web 登录表单中输入原始密码。登录后拥有服务管理员权限，凭据只保存在页面内存，
刷新后重新登录。`server.auth.sessionMs` 设置登录有效期，默认 28800000 ms（八小时），
范围为 1000 至 86400000 ms。断开连接会退出登录，服务重启会使全部登录失效。
可以在没有会话时启动 Web 服务，然后通过管理器创建会话。

远程 CLI 从 `MAYBECLAW_ADMIN_PASSWORD` 或 `--password-env <name>` 指定的环境变量
读取密码，登录并执行命令，完成后退出登录。本地命令通过文件系统权限访问数据。
API 客户端向 `/api/auth/login` POST `{ "password": "..." }`，将返回的 `token`
作为 Bearer 凭据使用，有效期截止到 `expiresAt`。携带凭据 POST `/api/auth/logout`
即可退出。密码哈希不能用作登录凭据。密码验证最多并发两次，每分钟最多尝试十次，
登录成功会清除尝试次数记录。每个服务最多允许 128 个有效登录。

Web 管理器提供图形化创建和“直接使用命令创建”，复用相同的 Gateway 命令与校验。
发送普通消息前必须创建会话。浏览只改变当前页面；设置聊天入口默认会话通过独立
管理操作完成。会话默认 Agent 的修改对全部获准成员和访问界面共同生效。管理器
同时提供 Agent 配置、入口绑定、会话管理员、审批、渠道状态和独立历史任务查看。

```powershell
pnpm maybeclaw task submit "检查这段修改" --session <session-id> --agent reviewer --server http://127.0.0.1:3939 --request-id review-1
pnpm maybeclaw task status <task-id> --server http://127.0.0.1:3939
pnpm maybeclaw task result <task-id> --server http://127.0.0.1:3939
pnpm maybeclaw task cancel <task-id> --server http://127.0.0.1:3939
pnpm maybeclaw session rename <session-id> --name "发布评审" --server http://127.0.0.1:3939
pnpm maybeclaw agent save reviewer --definition reviewer.json --server http://127.0.0.1:3939
pnpm maybeclaw channel status --server http://127.0.0.1:3939
```

`serve` 运行期间使用 `--server`；直接运行本地命令需要取得数据目录的独占使用权限。
本地提交等待任务完成，并在交互终端读取明确的审批决定。服务端接收任务后返回，
客户端退出后工作继续。`task recover` 核对指定任务的证据；`task run` 派发其符合
恢复条件的协作图。工具结果未知时需要完成核对。模型与目录选项通过 Agent 配置管理。

JSON 接口位于 `/api/v2`，包含 `sessions`、`tasks`、`agents`、`approvals`、`commands`
和 `health`。提交任务需要 `sessionId`、`prompt` 和 `requestId`。同一标识和相同
正文重复提交已接收任务，会返回原有凭据；正文改变时拒绝。

其他设备访问控制端时，在 `server.publicOrigin` 填写准确的 HTTPS origin，例如
`https://gateway.example:8443`。使用 HTTPS 反向代理连接本机监听端口，保留浏览器
的 Host 与 Origin，将全部路径转发至该端口，并允许 UI 事件使用流式响应。
服务只接受本地 origin 或配置的公网 origin 对应的 Host/Origin 组合；转发请求头
不会授权其他地址。API 继续要求服务管理员登录。部署时为代理配置适当的访问限制。
origin 使用规范形式，不包含末尾斜杠、路径、查询参数、片段、用户信息或显式默认
端口 `:443`。

May 工具中断时，在对应会话发送 `/agent command <agent> recovery` 查询待核对
操作。核实实际结果后，通过 `/agent command <agent> resolve-recovery <id> <核实结论>`
保存证据，再用 `task recover <task-id>` 检查原任务。这个操作不会重新执行原工具，
后续工作通过新输入提交。

## 聊天命令与打断

```text
/session create "项目评审" --agent code --allow-agent reviewer
/session list
/session select "项目评审"
/session "项目评审" @reviewer 检查错误处理
/agent default reviewer
/steer 同时检查权限处理
/stop --task <task-id>
/history --before <sequence>
```

明确指定的目标优先，其后依次使用平台原生回复关联和入口默认值。
`/session A 正文` 只指定当前消息；`/session select A` 修改入口默认会话。
选择回复会显示进行中的任务、未发送消息数量，以及需要核对的投递数量。
`/agent default` 修改整个会话的默认 Agent，`@agent` 只指定当前消息。
`/new`、`/resume` 通过 Gateway 会话管理处理。Agent 专用命令使用
`/agent command <agent> <command>`，并要求适配器声明支持。

普通新消息打断有权操作的目标，等待取消完成后开始后续执行。`/steer` 保持当前
Step 继续运行，随后按接收顺序在下一次模型请求前交付。审批等待继续等待。
正常完成后未交付的输入开始后续工作；明确取消后保留输入供用户重新提交。
不支持的能力返回明确说明。

## 渠道、成员与审批

在 `apps.maybeclaw.channels` 中增加渠道配置：

```json
{
  "telegram": { "enabled": true, "botTokenEnv": "MAYBECLAW_TELEGRAM_TOKEN", "allowUsers": ["123456789"], "allowGroups": ["-1001234567890"], "groupTrigger": "explicit" },
  "feishu": { "enabled": true, "appId": "cli_replace_with_your_app_id", "appSecretEnv": "MAYBECLAW_FEISHU_SECRET", "allowUsers": ["ou_replace_with_your_open_id"], "allowGroups": ["oc_replace_with_your_chat_id"] }
}
```

启用渠道需要明确的用户或群聊允许名单。群聊默认在提及机器人、回复 Gateway 消息、
发送命令或明确目标标记时触发。专用群聊可以设置 `groupTrigger: "all"`，
`entranceTriggers` 可以为指定群聊或话题设置触发方式。事件是否可接收由平台决定。

成员退出群聊后，Gateway 撤销其群聊访问权限并取消其活动工作；后续加入事件恢复
配置范围内的访问。Telegram 订阅 `chat_member`，机器人必须具有群聊管理员权限
才能收到这些事件。飞书要求机器人位于群内，具备群组信息权限，并订阅
`im.chat.member.user.added_v1`、`im.chat.member.user.deleted_v1` 和
`im.chat.member.user.withdrawn_v1`。成员事件适用于群内全部话题，较早的事件不会
替换更新的成员状态。平台权限不足导致无法收到事件时，Gateway 无法据此确认成员
变更；服务管理员可以通过 `access.deniedUsers` 撤销访问。

服务管理员通过 `access.sessionAdmins` 或控制管理器指定会话管理员，身份使用
`telegram:<bot-id>:<user-id>` 等标识。会话管理权限来自这份配置。普通成员参与交流
并管理自己的工作；会话管理员修改共享设置、管理生命周期和审批。Agent 创建与
协作继续受服务级限制约束。

创建 Agent 和调用工具分别审批。一次创建决定不会修改免审批 Agent 名单。
`allow-session` 只适用于声明的授权范围和对应 Agent 对话。审批过期或者重复响应
不会增加权限。

平台消息在派发前编辑时，更新待处理正文；撤回时取消该待处理输入。派发后的编辑和
撤回保留原执行输入，并将变更通知写入会话历史，供 Web 和 `/history` 查看。
变更事件按平台事件 ID 去重，通知中的编辑正文保留原始空白。Web 消息标题显示
对应的平台账号和成员身份。

回复标明会话和 Agent。渠道断开和页面浏览期间工作继续。投递区分等待、发送中、
已发送和结果未知；重连不会重复执行。媒体需要 Agent 和平台同时支持。为控制端
会话绑定聊天入口时，需要明确确认向获准成员开放已有历史。

May Agent 通过 `media` 明确声明可接收类型，例如
`"media": ["image", "audio", "file", "video"]`，仅开启当前 Provider 支持的类型。
视频需要独立的 `video` 能力，输入通过文件 ContentPart 传递并保留 `video/*` MIME
类型；只声明 `file` 不会开启视频。RPC Agent 在能力握手时声明同样的类型。
Provider 继续验证其实际输入能力。

## 生命周期、存储与迁移

空闲资源按配置延迟释放，对话 ID 与历史继续保存。重启时，访问权限撤销、访问配置
或 Agent 版本变化会使对应的未完成任务进入待核对状态，其他会话继续恢复。持久记录
损坏时恢复直接报错。停用 Agent 拒绝新工作并等待
当前工作完成。模型或启动配置变化时，等待受影响工作完成后替换资源。归档要求
会话空闲并保留历史。删除需要确认清理 Gateway 记录、专用 Agent 对话和未发送输出；
用户项目文件与平台已有消息分别管理。外部清理未完成时继续显示状态。

共享进程或连接只在全部使用者均为空闲且适配器支持恢复时关闭。配置更新期间，
已接收工作的审批和协作继续处理；等待中的协作任务、待处理补充信息或未确认结果
需要先完成处理。服务关闭在 `shutdownMs` 宽限时间后取消执行，并等待输入、对话创建、
配置写入及资源清理结束后释放数据目录。

`gateway.sqlite` 通过事务保存会话、对话关联、消息、任务、审批、默认值、请求凭据
和投递记录。May 历史继续使用 Session 存储。`host.lock` 阻止其他进程同时写入。
处理遗留文件前需要核对其中记录的所有者已经停止。

```powershell
pnpm maybeclaw migrate check --data-directory <directory>
pnpm maybeclaw migrate run --data-directory <directory>
```

迁移核对使用权限、保存原数据备份、保留独立历史任务与渠道证据，并记录完成状态。
旧的排队工作等待明确分配到已创建会话。已发送消息保持已发送，结果未知的记录等待
核对。数据迁移之后需要明确配置 version 2 的 Agent 名单。真实 Provider 和平台
验证范围取决于实际适配器、凭据与网络。

服务管理员通过渠道状态查看迁移后的投递记录。核对未知发送结果之后，可以使用
`maybeclaw delivery retry-legacy <id> --confirm --server <url>` 明确接受平台消息
可能重复的情况，并将该记录恢复为等待投递。经过认证的 HTTP 操作为
`POST /api/v2/legacy-deliveries/<id>/retry`，正文为 `{ "confirmUnknown": true }`。
已经确认发送的消息不能重新发送。

当前消息与渠道回复使用 `delivery retry <id> --confirm --server <url>`，或使用
`POST /api/v2/deliveries/<id>/retry` 并传入相同的确认正文。Web 渠道管理器为结果
未知和发送失败的记录提供明确确认操作。重新发送只改变投递状态，不重新执行
Agent 的工作。
