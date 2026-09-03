# May configuration reference

**English** | [简体中文](../../zh-CN/reference/configuration.md)

May reads `~/.may/config.json` by default. The configuration separates named
provider connections, selectable model profiles, and application settings.

For editor completion and validation, associate the file with
[`packages/config/may-config.schema.json`](../../../packages/config/may-config.schema.json).
For example, on this Windows checkout the user configuration can start with:

```json
{
  "$schema": "file:///E:/code/May/packages/config/may-config.schema.json",
  "providers": {},
  "models": {}
}
```

The exact file URL depends on the checkout location. Editors also allow mapping
`~/.may/config.json` to the schema in workspace
settings without adding `$schema` to the file.

## Top-level fields

| Field | Required | Description |
| --- | --- | --- |
| `providers` | yes | Named connections containing an adapter, credentials, endpoint, and shared options. |
| `models` | no | Named model profiles shown by model selectors such as MaybeCode `/model`. |
| `defaultModel` | no | The model profile selected when no explicit model is supplied; MaybeCode `/model` can update it. |
| `apps` | no | Application-owned settings. |

Provider fields are `adapter`, `apiKey`, `apiKeyEnv`, `baseURL`, and `options`.
Do not set both `apiKey` and `apiKeyEnv`. Model fields are `provider`, optional
`adapter`, `model`, `contextWindowTokens`, `maxOutputTokens`, `options`, and
`capabilities`.
When a model omits `adapter`, it inherits the provider adapter. Provider options
and model options are shallow-merged, with model values taking precedence.

Prefer `apiKeyEnv` over embedding secrets in JSON:

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

MaybeCode's model picker can persist a different `defaultModel`. It rereads and
validates the loaded file, updates only that top-level field, and replaces the
file atomically. Setting the default does not switch the active model unless
the command form `/model <profile-prefix> --default` is used.

## Built-in adapter options

`options` is adapter-specific. The built-in registry currently recognizes:

| Adapter | Options |
| --- | --- |
| `openai-responses` | `maxOutputTokens`, `reasoningEffort`, `reasoningSummary`, `serverCompactThreshold`, `store` |
| `openai-chat-completions` | `maxOutputTokens`, `reasoningEffort`, `store` |
| `deepseek-chat` | `thinking`, `reasoningEffort`, `maxTokens` |
| `zhipu-chat` | `thinking`, `clearThinking`, `reasoningEffort`, `maxTokens` |
| `kimi-chat` | `thinking`, `reasoningEffort`, `maxTokens` |
| `anthropic-messages` | `thinking`, `reasoningEffort`, `maxTokens`, `apiVersion` |

Common scalar values:

- `reasoningEffort` is a non-empty model-specific string. The adapter only
  serializes the selected value; model capability metadata determines the
  choices shown by MaybeCode. This also lets enhanced compatible providers add
  a level without waiting for a new adapter release.
- OpenAI `reasoningSummary`: `auto`, `concise`, or `detailed`.
- Token limits and `serverCompactThreshold` are positive integers.

The adapter validates option shapes when the model is instantiated. It does not
treat a protocol-wide reasoning union as proof of support by a specific model.

## Model capabilities

May resolves model-specific capabilities separately from the adapter's broad
protocol-level option validation. The resolution order is:

1. A model profile's explicit `capabilities` override.
2. An enhanced provider model endpoint. For OpenAI-compatible connections,
   May recognizes CLIProxyAPI's Codex catalog at
   `/v1/models?client_version=...` and reads `supported_reasoning_levels`.
3. May's built-in model catalog, maintained from vendor documentation.
4. `unknown` when no reliable source describes the model.

The standard OpenAI `/v1/models` response only identifies models; May does not
guess reasoning levels from the model name. Provider discovery failures also
fall through to the built-in catalog or `unknown`.

Override incorrect or missing metadata on a model profile:

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

`defaultEffort` must be one of `efforts`. An explicit override always wins,
including over a provider's enhanced catalog.

The initial built-in catalog covers the documented GPT-5.6 family and the
DeepSeek V4 API model IDs. GPT-5.6 levels come from the
[OpenAI model guide](https://developers.openai.com/api/docs/models/gpt), and
DeepSeek levels come from the
[DeepSeek thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode/).

### Thinking objects

Kimi uses an object:

```json
{ "thinking": { "type": "enabled", "keep": "all" } }
```

Anthropic accepts disabled, adaptive, or explicitly budgeted thinking:

```json
{
  "thinking": {
    "type": "enabled",
    "budgetTokens": 8192,
    "display": "summarized"
  }
}
```

## MaybeCode settings

`apps.maybecode` recognizes:

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
      }
    }
  }
}
```

Set `retry` to `false` to disable automatic retries. Relative instruction
directories are resolved from the directory containing `config.json`.

Observability is disabled when `observability` is absent, `false`, or has
`enabled: false`. An object enables the file exporter; `enabled` defaults to
`true`, `exporter` currently accepts only `file`, and `samplingRatio` defaults
to `1`. `file` is a base path: MaybeCode inserts the local `YYYY-MM-DD` before
its extension. Relative paths are resolved below the MaybeCode data directory;
the default files are
`~/.may/maybecode/traces/traces-YYYY-MM-DD.jsonl`.

`retentionDays` defaults to `60` local calendar days, including today. On the
first export of a new day, MaybeCode deletes only matching rotated files older
than that window. Batch defaults are the values shown above;
`maxExportBatchSize` cannot exceed `maxQueueSize`.

MaybeCode flushes the processor during workspace shutdown. Each daily JSONL
file is append-only. The files are fail-open operational telemetry rather than
Session or audit truth; see
[Observability and tracing](../guides/observability.md).

## Maintenance source of truth

The schema and this guide are user-facing references. When adding or changing a
built-in adapter option, update both alongside the runtime parsing in
`packages/providers/src/builtins.ts`.
