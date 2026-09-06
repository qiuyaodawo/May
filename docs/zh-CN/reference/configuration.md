# May 配置参考

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

```json
{
  "apps": {
    "maybecode": {
      "instructionsDirectory": "instructions/maybecode",
      "autoCompaction": {
        "providerNative": false
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
