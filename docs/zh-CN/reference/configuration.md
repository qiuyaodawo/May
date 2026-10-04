# May 配置参考

MaybeCode 接受 `apps.maybecode.plugins`，MaybeClaw 的 May Agent 接受
`apps.maybeclaw.agents[].plugins`。每项包含本地模块或已安装 package 名称，以及
可选导出名称、配置和启用标记。模块按照配置文件位置解析。参阅
[插件指南](../guides/plugins.md)。

## MaybeCode 项目 Git 管理

`apps.maybecode.git` 默认值为 `{}`，接受 `false` 关闭项目 Git 管理。
配置对象支持 `autoCommit`（默认 `true`）、`readOnly`（默认 `false`）、
`dataRoot`、`worktreesRoot` 和 `excludedPaths`（项目路径数组）。配置中的
目录按照配置文件所在目录解析。记录目录与 worktree 根目录必须位于项目仓库之外。
已有仓库继续使用原有版本；新项目建立仓库及初始 checkpoint。自动提交在完整请求
结束后进行，提交范围遵循项目忽略规则。

`autoCommit: false` 保留 Git 状态读取与已有版本的 checkpoint，文件修改保持
未提交。`readOnly: true` 禁止 Git 初始化与修改，内置工具审批策略同时禁止改变项目的
工具操作。headless 宿主可以通过
`git.authorizeCommit` 执行审批策略。Git 配置与工具审批模式分别控制各自的操作。
Session 分支、worktree 生命周期、文件排除与恢复预览见
[Git 工作区与 checkpoint](../guides/git-workspaces.md)。

## MaybeCode 权限模式

`apps.maybecode.persistentRules` 默认值为 `false`。设置为 `true` 后，文件
`edit` 和 `write` 的持久授权保存到当前项目的 `.may/permission-rules.json`。
审批选项显示规范化后的实际文件路径。规则按本地用户、项目或 worktree、主 Agent
身份隔离，会话或模型切换继续使用已有规则。宿主持有存储与单个进程的写入锁，关闭时
释放资源。规则文件和锁文件排除在项目 Git checkpoint 之外。
`/permissions [list|allow <id>|deny <id>|revoke <id>]` 和 WebUI 提供已有范围的
管理操作，每条规则记录创建者，禁止规则优先。headless 宿主可以通过
`openConfiguredMaybeCode({ persistentRules })` 覆盖配置。
参阅[权限策略](../guides/permission-policy.md)。

`apps.maybecode.permissionMode` 接受 `"default"`（默认值）或 `"yolo"`。
YOLO 自动批准工具请求，并保留权限策略明确禁止的操作。启动参数 `--yolo`
和 `--no-yolo` 优先于配置；同时使用两个参数会报错。

`/yolo [on|off|status]` 和 WebUI 的 Permissions 选择器控制当前 workspace
宿主。`/yolo` 和 `/yolo on` 开启模式，`/yolo off` 关闭模式，`/yolo status`
仅查询当前状态。重复输入 `/yolo` 会保持开启。切换之前需要暂停或取消正在执行的
run、goal 和 MCP 操作。宿主中的
会话切换和模型切换继续使用当前模式；模式不会从对话历史恢复，也不会写入配置。
重新启动时依据当前启动参数和配置确定模式。`/goal` 使用宿主当前权限，无法自行开启 YOLO。

终端与 WebUI 在开启期间显示 `YOLO · Auto-approve`，模式变化提示使用英文。
通用 WebUI 通过可选的 `UiSnapshot.badges` 在固定顶部显示宿主状态，阅读历史会话时
也会显示。classic 终端通过 `TerminalIO.updatePrompt` 更新模式，保留输入文字和光标位置。
工具参数检查、取消机制和执行记录继续生效。MCP 用户输入请求仍然需要回答。
YOLO 不提供系统隔离，shell 命令具有宿主账户的系统权限。Team 使用独立的授权设置。

`apps.maybecode.skills` 支持 `false` 或 `{ "directories": ["./skills"] }`。
发现优先级和路径解析见 [Agent Skills](../guides/skills.md)。

MaybeCode 支持 `apps.maybecode.runBudget`，限制每次 Run 的时长、步骤、模型／工具调用、
token 和估算成本。参见[运行预算](../guides/run-budgets.md)。

`apps.maybecode.subagents` 配置子 Agent 委派，默认启用。`false` 或
`{ "enabled": false }` 关闭它。该对象接受 `roles`（`model`、`reasoningEffort`、
`instructions`、`tools`、`delegateTo`、`runBudget`）、`defaultRole`、`limits`
（`maxConcurrent`、`maxTasks`、`maxDepth`、`maxTaskTurns`、`maxDurationMs`、
`maxInputBytes`、`maxOutputBytes`）、子 Agent 的 `runBudget`，以及请求级额度
`maxModelCalls`、`maxTotalTokens`、`reservationTokens`。没有配置 `roles` 时注册
`worker` 角色。参见[子 Agent 委派](../guides/subagent-delegation.md)。

[English](../../en/reference/configuration.md) | **简体中文**

May 默认读取 `~/.may/config.json`。配置把命名 provider 连接、可选 model profile
和应用设置分开保存。

为了获得编辑器补全与校验，请将配置文件关联到
[`packages/config/may-config.schema.json`](../../../packages/config/may-config.schema.json)。
例如，在当前 Windows checkout 中可以这样开始：

```json
{
  "$schema": "file:///E:/code/May/packages/config/may-config.schema.json",
  "providers": {},
  "models": {}
}
```

具体文件 URL 取决于 checkout 位置。也可以在 workspace 编辑器设置中把
`~/.may/config.json` 映射到 schema，而不在文件里加入 `$schema`。

## 顶层字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `providers` | 是 | 命名连接，包含 adapter、凭据、endpoint 和共享选项。 |
| `models` | 否 | 供 MaybeCode `/model` 等模型选择器展示的命名 profile。 |
| `defaultModel` | 否 | 未显式指定模型时选用的 profile；MaybeCode `/model` 可以更新它。 |
| `apps` | 否 | 应用自有设置。 |

Provider 字段包括 `adapter`、`apiKey`、`apiKeyEnv`、`baseURL` 和 `options`。
不要同时设置 `apiKey` 与 `apiKeyEnv`。Model 字段包括 `provider`、可选
`adapter`、`model`、`contextWindowTokens`、`maxOutputTokens`、`options`
和 `capabilities`。

模型未设置 `adapter` 时继承 provider adapter。Provider 与 model 的 `options`
进行浅合并，model 值优先。

应优先使用 `apiKeyEnv`，不要把 secret 写入 JSON：

```json
{
  "providers": {
    "cliproxy": {
      "adapter": "openai-responses",
      "apiKeyEnv": "CLIPROXY_API_KEY",
      "baseURL": "http://127.0.0.1:8317/v1",
      "options": { "store": false }
    }
  },
  "models": {
    "cliproxy-high": {
      "provider": "cliproxy",
      "model": "model-id-from-v1-models",
      "options": { "reasoningEffort": "high" }
    }
  },
  "defaultModel": "cliproxy-high"
}
```

MaybeCode 的模型选择器可以持久化新的 `defaultModel`。它会重新读取并校验当前文件，
只更新该顶层字段，再原子替换文件。设置默认值不会自动切换活动模型，除非使用
`/model <profile-prefix> --default`。

## 内置 adapter 选项

`options` 由 adapter 定义。内置 registry 当前识别：

| Adapter | 选项 |
| --- | --- |
| `openai-responses` | `maxOutputTokens`、`reasoningEffort`、`reasoningSummary`、`serverCompactThreshold`、`store` |
| `openai-chat-completions` | `maxOutputTokens`、`reasoningEffort`、`store` |
| `deepseek-chat` | `thinking`、`reasoningEffort`、`maxTokens` |
| `zhipu-chat` | `thinking`、`clearThinking`、`reasoningEffort`、`maxTokens` |
| `kimi-chat` | `thinking`、`reasoningEffort`、`maxTokens` |
| `anthropic-messages` | `thinking`、`reasoningEffort`、`maxTokens`、`apiVersion` |

常见标量：

- `reasoningEffort` 是非空且由模型定义的字符串。Adapter 只序列化所选值；
  model capability metadata 决定 MaybeCode 展示哪些选项，也允许增强型兼容
  provider 增加新等级而无需等待 adapter 发布。
- OpenAI `reasoningSummary`：`auto`、`concise` 或 `detailed`。
- token 限制和 `serverCompactThreshold` 必须为正整数。

Adapter 在实例化模型时校验选项形状。协议级 reasoning union 并不代表某个具体模型
一定支持其中所有值。

## 模型 Capability

May 将模型 capability 与 adapter 的协议级选项校验分开解析，优先级为：

1. model profile 中显式设置的 `capabilities`；
2. 增强型 provider 模型 endpoint。对于 OpenAI 兼容连接，May 能识别
   CLIProxyAPI 的 Codex catalog：`/v1/models?client_version=...`，并读取
   `supported_reasoning_levels`；
3. 根据厂商文档维护的 May 内置模型 catalog；
4. 无可靠来源时为 `unknown`。

标准 OpenAI `/v1/models` 响应只标识模型；May 不会根据模型名称猜测 reasoning
等级。Provider discovery 失败时也会回退到内置 catalog 或 `unknown`。

可在 profile 中覆盖错误或缺失的 metadata：

```json
{
  "models": {
    "private-model": {
      "provider": "private-endpoint",
      "model": "private-reasoner",
      "capabilities": {
        "reasoning": {
          "efforts": ["low", "medium", "high"],
          "defaultEffort": "medium"
        }
      }
    },
    "non-reasoning-model": {
      "provider": "private-endpoint",
      "model": "private-chat",
      "capabilities": { "reasoning": false }
    }
  }
}
```

`defaultEffort` 必须属于 `efforts`。显式覆盖始终优先，包括优先于 provider 的增强
catalog。

初始内置 catalog 覆盖文档化的 GPT-5.6 系列和 DeepSeek V4 API model ID。
GPT-5.6 等级来源于 [OpenAI 模型指南](https://developers.openai.com/api/docs/models/gpt)，
DeepSeek 等级来源于
[DeepSeek thinking-mode 指南](https://api-docs.deepseek.com/guides/thinking_mode/)。

### Thinking 对象

Kimi 使用对象：

```json
{ "thinking": { "type": "enabled", "keep": "all" } }
```

Anthropic 接受禁用、自适应或显式 token budget：

```json
{
  "thinking": {
    "type": "enabled",
    "budgetTokens": 8192,
    "display": "summarized"
  }
}
```

## MaybeCode 设置

`apps.maybecode` 识别：

`autoCompaction.mode` 选择独立的自动压缩模式：`prune-summary`（默认，先裁剪旧工具
结果，仍超阈值时再摘要）、`history-reference`（用历史引用重置较早上下文），或
`provider-native`（仅原生压缩，要求模型支持）。模式之间不会自动降级；压缩后仍超
阈值时停止 Run，已变化的上下文仍会持久化。旧的 `autoCompaction.providerNative`
布尔配置已弃用；没有 `mode` 时，`true` 选择仅原生压缩，显式 `mode` 优先。

手动 `/compact` 默认执行裁剪与摘要。`/compact history-reference` 和
`/compact provider-native` 分别执行独立操作，不改变自动模式。编程接口通过
`autoCompactionMode` 选择同样的模式；显式 `autoCompactionStrategies` 覆盖模式，
空数组 `[]` 禁用自动压缩。

历史引用模式现在要求先保存工作笔记，而不只是放一个历史查询提示。模型可以用
`get_context_remaining` 查询容量、用 `context_notes` 保存笔记，再调用 `new_context`。
系统在达到重置阈值的 80% 时提醒，原阈值仍是硬边界；缺少笔记或笔记过时会阻止重置。
交接、查询与失败处理规则见 [Context 与持久化历史](../concepts/context-and-history.md#历史引用模式的工作记忆)。

```json
{
  "apps": {
    "maybecode": {
      "instructionsDirectory": "instructions/maybecode",
      "autoCompaction": {
        "mode": "prune-summary"
      },
      "subagents": {
        "roles": {
          "worker": { "tools": ["read", "shell", "edit", "write"], "delegateTo": ["worker"] }
        },
        "defaultRole": "worker",
        "limits": { "maxConcurrent": 2, "maxDepth": 3 }
      },
      "retry": {
        "maxAttempts": 3,
        "baseDelayMs": 500,
        "maxDelayMs": 8000,
        "jitterRatio": 0.2
      },
      "observability": {
        "enabled": true,
        "exporter": "file",
        "file": "traces/traces.jsonl",
        "samplingRatio": 1,
        "retentionDays": 60,
        "batch": {
          "maxQueueSize": 2048,
          "maxExportBatchSize": 512,
          "scheduledDelayMs": 5000
        }
      },
      "mcpServers": {
        "workspace": {
          "transport": "stdio",
          "command": "node",
          "args": ["tools/mcp-server.mjs"],
          "cwd": ".",
          "required": false,
          "env": { "ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}" },
          "requestTimeoutMs": 60000,
          "maxTotalTimeoutMs": 300000,
          "maxBufferSize": 10485760,
          "stderrMaxBytes": 16384
        }
      }
    }
  }
}
```

将 `retry` 设为 `false` 可禁用自动重试。相对 instruction 目录以
`config.json` 所在目录为基准解析。

`observability` 缺失、为 `false` 或包含 `enabled: false` 时禁用可观测性。配置 object
会启用文件 exporter；`enabled` 默认为 `true`，`exporter` 目前只接受 `file`，
`samplingRatio` 默认为 `1`。`file` 是基础路径；MaybeCode 会在扩展名前插入本地日期
`YYYY-MM-DD`。相对路径基于 MaybeCode data directory 解析，默认文件为
`~/.may/maybecode/traces/traces-YYYY-MM-DD.jsonl`。

`retentionDays` 默认保留包括今天在内的最近 `60` 个本地日历日。每天首次导出时，
MaybeCode 只删除早于保留窗口、且名称与轮转规则匹配的文件。Batch 默认值如上，且
`maxExportBatchSize` 不能超过 `maxQueueSize`。

MaybeCode 会在 workspace 关闭时 flush processor。每天的 JSONL 文件只追加；这些文件
是 fail-open 的运行遥测，不是 Session 或 audit 事实来源。参阅
[可观测性与 Tracing](../guides/observability.md)。

`mcpServers` 缺失或为 `false` 时禁用 MCP。每个 property name 都是 server id，并
用于生成模型可见工具名。Entry 默认使用 `stdio` transport，必须提供 `command`，
还可提供 `args`、`cwd`、`env`、请求超时、总超时、消息 buffer 上限和 stderr 末尾
保留上限。Server 默认 required，因此连接或发现失败会中止启动；将 `required` 设为
`false`，可在记录该 server 失败的同时继续使用应用。将 `enabled` 设为 `false`，即可
在不删除配置的情况下跳过它。

HTTP 端点设置 `transport: "streamable-http"`，必须提供 `url`，可设置 `headers`
（支持 `${NAME}` 环境引用）、`auth`、`required`、请求/总超时及 `protocolMode`。HTTP entry
不接受 `command`、`args`、`cwd`、`env`、`maxBufferSize`、`stderrMaxBytes`；stdio
entry 不接受 `url`/`headers`。`protocolMode` 接受 `legacy` 或 `auto`，stdio 默认
legacy，HTTP 默认 auto。除 loopback 外必须使用 HTTPS，不跟随重定向；尚未实现
自动重连。`auth: { "type": "oauth" }` 启用原生 OAuth，可选字段包括 `account`、
`clientId` 加 `expectedIssuer`、`clientMetadataUrl`、`scopes`、`authorizationOrigins`
和 `callbackPort`。OAuth 与静态 Authorization header 互斥。登录、退出、凭据存储和
origin 限制参阅 [MCP 认证](../guides/mcp-auth.md)。

相对 `cwd` 和省略的 `cwd` 都以当前 MaybeCode workspace 为基准。环境字符串会从
启动进程展开 `${NAME}`，缺失引用会使启动失败。配置文件是明文，因此应优先使用
环境引用。发现的工具会加入 namespace，经过 MaybeCode 的正常 permission 与
scheduling 路径，每个 Run 使用固定快照；显式 refresh/reconnect 与目录通知只影响
后续 Run。`/mcp` 会显示 server 状态、协商协议版本、工具、
错误和有界、已净化的 stderr 末尾片段。参阅 [MCP 工具](../guides/mcp.md)。

## MaybeCode 终端交互

MaybeCode 的 retained 终端界面通过 `MAY_TUI_LEADER` 设置显示操作组合键的起始按键，
默认 `ctrl+g`。应当选择包含修饰键且与输入框快捷键没有冲突的单个按键。
`MAY_CLIPBOARD` 支持 `auto`、`system`、`osc52` 和 `disabled`；本机 auto 使用系统
剪贴板，SSH 需要明确配置 OSC 52 并允许终端写入剪贴板。这些环境设置由界面使用，
不会进入 Agent 的上下文。参阅[终端交互](../getting-started.md#查看-maybecode-对话)。

## MaybeClaw 设置

`apps.maybeclaw` 使用 `version: 2`、可选的 `agents` 列表（省略时规范为 `[]`）、`access`、
`server` 以及 `channels.telegram` / `channels.feishu`。`server.maxConcurrent` 默认值为 4。
启动服务时，缺少 MaybeClaw 配置或管理员认证会进入本机密码初始化页面。初始化保留
已有设置，直接保存 `passwordHash`，并补充缺失的 `version: 2` 和空 Agent 列表。
已有旧配置需要明确迁移。手动配置时，可以填写管理员密码、`version: 2` 和 `agents: []`（或省略 `agents`）启动 Web 控制台，
通过 Web 管理器添加首个 Agent 并创建会话，无需重启服务。保留 May 已有的 `providers` 和 `models`
供 May Agent 使用。
每个 Agent 分别配置模型、启动参数、权限和 `runBudget`。

`apps.maybeclaw.persistentRules` 默认值为 `false`。启用后，规则保存于
`<data-directory>/permission-rules.json`，由 Gateway 持有单个进程的写入锁。
May Agent 规则区分发起者身份、Agent 和规范化的项目路径。服务管理员可以选择
持久授权，并通过 Web 管理器创建、查看和撤销规则。渠道用户继续使用普通审批选项。
管理事件保存在 Gateway 存储中；工具执行与审批事件保存在 Agent Session 历史中。
参阅[权限策略](../guides/permission-policy.md)。

渠道默认关闭，启用时需要
配置允许访问的用户或群聊。Telegram 支持直接填写 `botToken`，或用 `botTokenEnv` 指定环境变量名；
飞书对应 `appSecret` / `appSecretEnv`。每一对字段不能同时填写，都省略时使用默认
环境变量。直接填写的凭据以明文保存，应保护配置文件且不要提交到仓库。
渠道配置变更后重启 `serve`。
Gateway `serve` 需要 `server.auth.password`（10 至 1024 个字符）或自动生成的
`passwordHash`。启动和配置保存时会将密码转换为带随机盐的 Argon2id 哈希，修改密码
会使已有登录失效。`server.auth.sessionMs` 默认为 28800000，接受 1000 至 86400000
毫秒。Web 输入原始密码登录；远程 CLI 从 `MAYBECLAW_ADMIN_PASSWORD` 或
`--password-env` 指定的变量读取密码。
编辑器 schema 为两款产品共享 RunBudget 定义。Agent 定义、权限、聊天入口、认证及
执行/恢复边界参阅 [MaybeClaw 指南](../guides/maybeclaw.md)。

## 维护时的事实来源

Schema 和本文档都是面向用户的参考。新增或修改内置 adapter 选项时，应同时更新
它们以及 `packages/providers/src/builtins.ts` 中的运行时解析。


两种 transport 都接受 `host: { roots: true, sampling: true, legacyRequests: "isolated" }`，
三个选项均需主动启用。Roots/Sampling 还需要交互 UI；headless 使用需显式开启并
消费 `mcpInteractions`。旧协议隔离为每次交互工具/read/prompt 操作创建新进程/session，
不保留操作间的服务端会话状态。参阅 [Host 兼容](../guides/mcp.md) 中的同意机制、
预算与自定义服务。内置编辑器 schema 已覆盖 HTTP、OAuth 和 Host 字段；运行时还会
检查端点/请求头安全约束。

两种传输还支持 `tasks: true`（默认 `false`），要求现代 2026-07-28 及服务端 Tasks
扩展。stdio 还需 `protocolMode: "auto"`。MaybeCode 默认使用
`<dataDirectory>/mcp-tasks` 加密 journal；自定义池 Host 必须注入 `taskJournal`。
存储失败阻止任务创建。Host 输入仍需相应显式服务及交互 UI。控制命令和重启边界
参阅[长任务](../guides/mcp-tasks.md)。
