# May 配置参考

[English](../../en/reference/configuration.md) | **简体中文**

May 默认读取 `~/.may/config.json`，分别保存命名 Provider 连接、模型配置和应用设置。
本文用于查询字段与默认值。应用启动及操作见[MaybeCode](../guides/maybecode.md)和
[MaybeClaw](../guides/maybeclaw.md)。

为了获得编辑器补全与校验，请将配置文件关联到
[`packages/config/may-config.schema.json`](../../../packages/config/may-config.schema.json)。
例如，仓库位于 `E:/code/May` 时，可以使用以下配置：

```json
{
  "$schema": "file:///E:/code/May/packages/config/may-config.schema.json",
  "providers": {},
  "models": {}
}
```

具体文件 URL 取决于仓库位置。也可以在编辑器的工作区设置中把
`~/.may/config.json` 映射到 schema。

## 顶层字段

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `providers` | 是 | 命名连接，包含 Adapter、凭据、端点和共享选项。 |
| `models` | 否 | 供 MaybeCode `/model` 等模型选择器展示的命名配置。 |
| `defaultModel` | 否 | 未明确指定模型时选用的配置；MaybeCode `/model` 可以更新它。 |
| `apps` | 否 | 应用自有设置。 |

Provider 字段包括 `adapter`、`apiKey`、`apiKeyEnv`、`baseURL` 和 `options`。
不要同时设置 `apiKey` 与 `apiKeyEnv`。Model 字段包括 `provider`、可选
`adapter`、`model`、`contextWindowTokens`、`maxOutputTokens`、`options`
和 `capabilities`。

模型省略 `adapter` 时继承对应 Provider 连接的 Adapter。Provider 与模型的
`options` 执行浅层合并，模型配置的值优先。

通过 `apiKeyEnv` 引用启动进程的环境变量：

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

## 内置 Adapter 选项

`options` 由 Adapter 定义，内置注册表识别以下选项：

| Adapter | 选项 |
| --- | --- |
| `openai-responses` | `maxOutputTokens`、`reasoningEffort`、`reasoningSummary`、`serverCompactThreshold`、`store`、`responseFormat` |
| `openai-chat-completions` | `maxOutputTokens`、`reasoningEffort`、`store`、`responseFormat` |
| `deepseek-chat` | `thinking`、`reasoningEffort`、`maxTokens` |
| `zhipu-chat` | `thinking`、`clearThinking`、`reasoningEffort`、`maxTokens` |
| `kimi-chat` | `thinking`、`reasoningEffort`、`maxTokens` |
| `anthropic-messages` | `thinking`、`reasoningEffort`、`maxTokens`、`apiVersion` |

常见标量：

- `reasoningEffort` 是非空且由模型定义的字符串。Adapter 序列化所选值，模型能力
  元数据决定 MaybeCode 显示的选项。增强型兼容 Provider 可以通过元数据提供新的等级。
- OpenAI `reasoningSummary`：`auto`、`concise` 或 `detailed`。
- token 限制和 `serverCompactThreshold` 必须为正整数。
- 所有内置 Adapter 接受 `unknownCapabilityPolicy`：`allow`（默认）或
  `require-known`，用于决定请求所需能力未知时的处理方式。

Adapter 在创建模型时校验选项结构，具体模型支持的 reasoning 值通过能力元数据确定。

## 模型能力

May 分别处理模型能力与 Adapter 协议级选项校验。模型能力按以下优先级解析：

1. 模型配置中明确设置的 `capabilities`；
2. 增强型 Provider 的模型端点。对于 OpenAI 兼容连接，May 能识别
   CLIProxyAPI 的 Codex 目录：`/v1/models?client_version=...`，并读取
   `supported_reasoning_levels`；
3. 根据厂商文档维护的 May 内置模型目录；
4. 无可靠来源时为 `unknown`。

标准 OpenAI `/v1/models` 响应标识模型。能力记录包含经过内容限制的发现诊断，
缓存限制数量与有效时间，并支持明确刷新。未知字段保持 `unknown`。

可以将以下 `models` 片段合并到已有配置，覆盖缺失的能力元数据。
`private-endpoint` 需要指向已有 Provider 连接：

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

`defaultEffort` 必须属于 `efforts`。明确覆盖具有最高优先级。

### 能力字段声明

模型配置和 Provider 连接的 `capabilities` 都可以声明独立的 `fields`。
模型字段覆盖模型元数据，Provider 字段限制当前连接。有效能力同时考虑
模型、Adapter 和连接。明确的 `false` 表示不支持，任何层级明确不支持时，请求会在
发送之前被拒绝。省略的连接字段不增加限制。

```json
{
  "capabilities": {
    "fields": {
      "input.text": true,
      "input.image": true,
      "input.image.sources": ["url", "base64"],
      "maxImages": 4,
      "maxAttachmentBytes": 10485760,
      "structuredOutput.jsonSchema": true,
      "structuredOutput.schemaDialects": ["draft-07"],
      "structuredOutput.schemaConstraint": { "type": "object" }
    }
  },
  "options": {
    "unknownCapabilityPolicy": "require-known",
    "responseFormat": {
      "type": "jsonSchema",
      "name": "answer",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "answer": { "type": "string" } },
        "required": ["answer"],
        "additionalProperties": false
      }
    }
  }
}
```

这个对象属于模型的部分配置。`unknownCapabilityPolicy` 默认使用
`allow`；`require-known` 拒绝未知的请求要求。输入来源、附件大小和 MIME 限制
分别检查；外部附件信息需要由宿主提供。`options.responseFormat` 为 OpenAI
Responses 和 Chat Completions Adapter 配置默认请求格式。支持 `json` 和
`jsonSchema`；后者包含 `name`、`schema` 与可选的 `strict`。JSON Schema 使用
Ajv 验证 draft-07 和 2020-12，最终响应也需要通过验证。工具调用的中间响应允许
空正文。`structuredOutput.schemaConstraint` 可以声明 Provider 支持的 Schema
范围。

其他字段包含 `input.audio`、`input.file`、`input.resource`、
`input.audio.sources`、`input.file.sources`、`output.text`、`output.image`、
`output.audio`、`tools`、`tools.maxCalls`、`structuredOutput.json`、
`structuredOutput.schemaDialects`、`contextWindowTokens`、`maxOutputTokens`、
`maxAttachments`、`fileTypes`、`parameters`、`contextCompaction` 和
`reasoning.modes`。数字使用
正整数上限，数组保存允许的值，`parameters` 和
`structuredOutput.schemaConstraint` 使用同步 JSON Schema。`tools.maxCalls`
限制单次模型响应的工具调用数量。公共 API 还提供来源、各个层级的声明、记录版本
和时间、指定字段刷新与有数量限制的请求验证记录。全部 Adapter 支持
`unknownCapabilityPolicy`。使用 `require-known` 时，非空 Provider 参数需要
已知的 `parameters` 范围。`reasoning.modes` 保存允许的 `effort`、`budget`、
`adaptive`、`thinking` 或 `summary` 模式。Context 校验计算输入 token 估计与
请求的输出 token 预留量；缺少估计或预留量时报告 `unknown`。原生 Context
压缩在执行前检查压缩能力和输入支持。验证记录区分 `request-accepted`、
`response-validated` 和 `failed`，保存媒体数量、来源形式与已观测的字节范围，
不会保存正文。
### 请求与响应校验

`Model.preflight` 让 May 和 Model 封装在实际请求尝试和预算预留前执行请求
校验。遭到拒绝的请求不会产生实际 attempt 记录。
Model 封装的 `limits` 返回模型和连接声明中已知的最小上限。发现得到的
限制在能力解析后可用；宿主可以在创建 ContextController 前解析能力，将结果
用于初始预算。能力刷新不会自动修改已有的 Context 预算。模型配置的输出上限
也会作为实际输出预留量参加 preflight 校验。
最终 JSON 或 Schema 校验失败时抛出 `ModelResponseValidationError`，其中
`responseCompleted: true` 表示实际响应已经完成，`usage` 和 `cost` 保存接收的
计量结果。运行环境、预算和 attempt 记录保留实际用量；重试封装不会重试
这些已完成的响应。校验错误使用固定说明，不包含响应正文。

### 内置 reasoning 目录

内置 reasoning 目录维护于
[`packages/providers/src/capabilities.ts`](../../../packages/providers/src/capabilities.ts)。
目录未包含的模型通过明确的能力覆盖或端点发现提供能力。所选参数需要符合账户
支持的模型 API。

### Thinking 对象

以下对象属于 Provider 或模型的 `options`，根据所用 Adapter 选择对应结构。

Kimi 使用对象：

```json
{ "thinking": { "type": "enabled", "keep": "all" } }
```

Anthropic 接受禁用、自适应或明确的 token 预算：

```json
{
  "thinking": {
    "type": "enabled",
    "budgetTokens": 8192,
    "display": "summarized"
  }
}
```

## 应用插件

MaybeCode 接受 `apps.maybecode.plugins`，MaybeClaw 的 May Agent 接受
`apps.maybeclaw.agents[].plugins`。每项包含本地模块或已安装软件包名称，以及
可选导出名称、配置和启用标记。模块按照配置文件位置解析。参阅
[插件指南](../guides/plugins.md)。

## MaybeCode 项目 Git 管理

`apps.maybecode.git` 默认值为 `{}`，设置 `false` 关闭项目 Git 管理。对象字段包括
`autoCommit`（默认 `true`）、`readOnly`（默认 `false`）、`dataRoot`、`worktreesRoot`
和 `excludedPaths`（项目路径）。路径按照配置文件所在目录解析。记录目录和 worktree
根目录必须位于仓库之外。已有仓库继续使用，新项目建立仓库和初始 checkpoint。
完整请求结束后可以创建提交，遵循项目忽略规则。

`autoCommit: false` 保留 Git 观察和已有版本的 checkpoint，编辑保持未提交。
`readOnly: true` 禁止 Git 初始化和修改，并拒绝改变项目的内置工具操作。无界面宿主
可以通过 `git.authorizeCommit` 要求提交审批。工具审批模式独立配置。分支和文件恢复
见[Git 工作区](../guides/git-workspaces.md)。

## MaybeCode 权限模式

`apps.maybecode.permissionMode` 支持 `"default"`（默认）和 `"yolo"`。YOLO 自动
批准工具请求，权限策略明确禁止的操作继续生效。`--yolo` 和 `--no-yolo` 覆盖配置，
同时使用会校验失败。`/yolo` 和 `/yolo on` 开启模式，`/yolo off` 关闭模式，
`/yolo status` 查询状态。切换前暂停或取消活动 Run、目标和 MCP 操作。当前工作区宿主
在切换 Session 和模型时保留模式。重新启动后根据启动选项确定，不保存到历史或配置。
`/goal` 使用当前模式。

终端和 WebUI 显示 **YOLO · Auto-approve**，模式通知使用英文。WebUI 使用
`UiSnapshot.badges`；classic 终端通过 `TerminalIO.updatePrompt` 更新，保留输入和
光标。工具校验、取消和记录继续生效。MCP 用户输入请求需要回答。shell 命令具有
宿主账户权限，团队授权独立配置。

`apps.maybecode.persistentRules` 默认值为 `false`。启用后，`edit` 和 `write` 授权
保存到活动项目的 `.may/permission-rules.json`，审批时显示规范化文件路径。范围包含
本地用户、项目或 worktree，以及主 Agent；切换 Session 或模型保留匹配规则。宿主
持有单个写入者的锁，关闭时释放。规则文件和锁文件排除在 Git checkpoint 之外。
`/permissions [list|allow <id>|deny <id>|revoke <id>]` 和 WebUI 管理已有范围。
规则记录操作人员，禁止规则优先。`openConfiguredMaybeCode({ persistentRules })`
覆盖配置。参阅[权限策略](../guides/permission-policy.md)。

## MaybeCode 设置

`apps.maybecode` 识别：

- `skills`：`false` 或 `{ "directories": ["./skills"] }`，见
  [Skills 发现与路径](../guides/skills.md)。
- `runBudget`：每次 Run 的时长、Step、模型及工具调用、token 和估算成本限制，
  见[Run 预算](../guides/run-budgets.md)。
- `subagents`：默认启用，`false` 或 `{ "enabled": false }` 关闭。字段包含 `roles`
  （`model`、`reasoningEffort`、`instructions`、`tools`、`delegateTo`、`runBudget`）、
  `defaultRole`、`limits`（`maxConcurrent`、`maxTasks`、`maxDepth`、`maxTaskTurns`、
  `maxDurationMs`、`maxInputBytes`、`maxOutputBytes`）、子任务 `runBudget`，以及请求
  限制 `maxModelCalls`、`maxTotalTokens`、`reservationTokens`。没有 `roles` 时注册
  `worker`，见[子 Agent 委派](../guides/subagent-delegation.md)。

`autoCompaction.mode` 选择独立的自动压缩模式：`prune-summary`（默认，先裁剪旧工具
结果，仍超阈值时再摘要）、`history-reference`（用历史引用重置较早上下文），或
`provider-native`（仅原生压缩，要求模型支持）。模式之间不会自动降级；压缩后仍超
阈值时停止 Run，已变化的上下文仍会持久化。旧的 `autoCompaction.providerNative`
布尔配置已弃用；没有 `mode` 时，`true` 选择仅原生压缩，显式 `mode` 优先。

手动 `/compact` 默认执行裁剪与摘要。`/compact history-reference` 和
`/compact provider-native` 分别执行独立操作，不改变自动模式。编程接口通过
`autoCompactionMode` 选择同样的模式；显式 `autoCompactionStrategies` 覆盖模式，
空数组 `[]` 禁用自动压缩。

历史引用模式要求保存工作笔记。模型可以用
`get_context_remaining` 查询容量、用 `context_notes` 保存笔记，再调用 `new_context`。
系统在达到重置阈值的 80% 时提醒，达到阈值时需要重置；缺少笔记或笔记过时会阻止重置。
交接、查询与失败处理规则见 [Context 与持久化历史](../concepts/context-and-history.md#历史引用模式的工作记忆)。

以下片段配置指令、压缩、委派、重试、Tracing 与本地 MCP server。将片段合并到
包含 `providers` 和 `models` 的已有配置。启用之前，需要创建引用的指令目录和
server 模块，并在启动环境提供 `MCP_ACCESS_TOKEN`。

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

将 `retry` 设为 `false` 可禁用自动重试。相对指令目录以
`config.json` 所在目录为基准解析。

### 可观测性

`observability` 缺失、为 `false` 或包含 `enabled: false` 时禁用可观测性。配置对象
会启用文件 exporter；`enabled` 默认为 `true`，`exporter` 目前只接受 `file`，
`samplingRatio` 默认为 `1`。`file` 是基础路径；MaybeCode 会在扩展名前插入本地日期
`YYYY-MM-DD`。相对路径基于 MaybeCode 数据目录解析，默认文件为
`~/.may/maybecode/traces/traces-YYYY-MM-DD.jsonl`。

`retentionDays` 默认保留包括今天在内的最近 `60` 个本地日历日。每天首次导出时，
MaybeCode 只删除早于保留窗口、且名称与轮转规则匹配的文件。Batch 默认值如上，且
`maxExportBatchSize` 不能超过 `maxQueueSize`。

MaybeCode 会在工作区关闭时刷新 processor。每天的 JSONL 文件只追加，提供运行遥测。
持久化执行事实使用 Session 记录。参阅
[可观测性与 Tracing](../guides/observability.md)。

### MCP server

`mcpServers` 缺失或为 `false` 时禁用 MCP。每个属性名作为 server ID，
用于生成模型可见工具名。配置项默认使用 `stdio` 传输，必须提供 `command`，
还可提供 `args`、`cwd`、`env`、请求超时、总超时、消息缓冲上限和 stderr 末尾
保留上限。Server 默认 required，连接或发现失败会终止启动；将 `required` 设为
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
环境引用。发现的工具会加入名称空间，经过 MaybeCode 的权限与调度流程，每个 Run
使用固定快照；明确刷新、重新连接与目录通知影响后续 Run。`/mcp` 显示 server
状态、协商协议版本、工具、错误和大小受限且已经清理敏感信息的 stderr 末尾片段。
参阅 [MCP 工具](../guides/mcp.md)。

两种传输均接受 `host: { roots: true, sampling: true, legacyRequests: "isolated" }`。
三个选项需要分别启用。Roots/Sampling 还需要交互 UI；headless 使用需要启用并
消费 `mcpInteractions`。旧协议隔离为每次交互工具、read 或 prompt 操作创建新的
进程或 Session，服务端状态仅属于该次操作。同意机制、预算与自定义服务见
[Host 兼容](../guides/mcp.md)。编辑器 schema 包含 HTTP、OAuth 与 Host 字段，
运行时同时检查端点与请求头安全要求。

两种传输接受 `tasks: true`（默认 `false`），要求协议 2026-07-28 和服务端 Tasks
扩展。Stdio 还需要 `protocolMode: "auto"`。MaybeCode 使用
`<dataDirectory>/mcp-tasks` 加密日志，自定义连接池宿主需要注入 `taskJournal`。
存储失败阻止任务创建。Host 输入需要对应服务与交互 UI。控制命令和重启行为见
[长时间任务](../guides/mcp-tasks.md)。

## MaybeCode 终端交互

MaybeCode 保留对话记录的终端界面通过 `MAY_TUI_LEADER` 设置显示操作组合键的起始按键，
默认 `ctrl+g`。应当选择包含修饰键且与输入框快捷键没有冲突的单个按键。
`MAY_CLIPBOARD` 支持 `auto`、`system`、`osc52` 和 `disabled`；本机 auto 使用系统
剪贴板，SSH 需要明确配置 OSC 52 并允许终端写入剪贴板。这些环境设置由界面使用，
不会进入 Agent 的上下文。参阅[终端交互](../guides/maybecode.md#查看-maybecode-对话)。

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
