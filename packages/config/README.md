# `@may/config`

Optional configuration loading and validation for May applications.

The complete user-facing reference is in
[`docs/reference/configuration.md`](../../docs/reference/configuration.md) ([简体中文](../../docs/zh-CN/reference/configuration.md)). A JSON Schema for editor
completion and validation is available at
[`may-config.schema.json`](./may-config.schema.json) and is exported as
`@may/config/schema`.

```json
{
  "defaultModel": "deepseek-reasoner",
  "providers": {
    "deepseek-official": {
      "adapter": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com",
      "options": {
        "thinking": "enabled"
      }
    },
    "cliproxy": {
      "adapter": "openai-responses",
      "apiKeyEnv": "CLIPROXY_API_KEY",
      "baseURL": "http://127.0.0.1:8317/v1"
    }
  },
  "models": {
    "deepseek-reasoner": {
      "provider": "deepseek-official",
      "model": "deepseek-reasoner",
      "contextWindowTokens": 64000,
      "maxOutputTokens": 8192,
      "options": {
        "maxTokens": 8192
      }
    },
    "proxy-chat": {
      "provider": "cliproxy",
      "adapter": "openai-chat-completions",
      "model": "proxy-model"
    }
  },
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

```ts
import {
  loadMayConfig,
  resolveModelProfile,
  resolveProviderConfig,
  updateDefaultMayModel,
} from "@may/config";

const config = await loadMayConfig();
const deepseek = resolveProviderConfig(config, "deepseek-official");
const selectedModel = resolveModelProfile(config);
await updateDefaultMayModel(config.path, "proxy-chat");
```

By default, `loadMayConfig()` reads `~/.may/config.json`. Pass `{ path }` to
load another file. A provider is a named connection containing an adapter,
credentials, endpoint, and optional shared adapter options. A model profile
references that provider and may override its adapter. This allows one endpoint
to expose models through different protocols.

`models` contains the selectable model profiles. `contextWindowTokens` and
`maxOutputTokens` belong to the profile because limits vary by model. Provider
`options` are merged with model `options`, with model values taking precedence.
Provider names are user-defined and are not used to choose an adapter.

`apps` is an optional map of application-owned configuration. This package
validates that each entry is an object but leaves fields such as
`instructionsDirectory`, `autoCompaction`, and `retry` for the application to
interpret.

`apiKeyEnv` is resolved only when `resolveProviderConfig()` or
`resolveModelProfile()` selects that provider. The package does not instantiate
models, log configuration, or become a dependency of `@may/core`.
`@may/providers` can consume the resolved selection and interpret the
provider-specific options; custom applications may use a different registry.

`updateDefaultMayModel(path, profile)` rereads and validates the file before
atomically updating only `defaultModel`. It preserves the existing indentation,
line endings, trailing newline, and file mode, and refuses to replace a file
that changed during the operation.
