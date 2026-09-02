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
      }
    }
  }
}
```

将 `retry` 设为 `false` 可禁用自动重试。相对 instruction 目录以
`config.json` 所在目录为基准解析。

## 维护时的事实来源

Schema 和本文档都是面向用户的参考。新增或修改内置 adapter 选项时，应同时更新
它们以及 `packages/providers/src/builtins.ts` 中的运行时解析。
