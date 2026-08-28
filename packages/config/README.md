# `@may/config`

Optional configuration loading and validation for May applications.

```json
{
  "defaultModel": "deepseek-reasoner",
  "providers": {
    "deepseek": {
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com",
      "contextWindowTokens": 64000,
      "maxOutputTokens": 8192
    }
  },
  "models": {
    "deepseek-reasoner": {
      "provider": "deepseek",
      "model": "deepseek-reasoner",
      "options": {
        "maxTokens": 8192
      }
    }
  },
  "apps": {
    "maybecode": {
      "instructionsDirectory": "instructions/maybecode"
    }
  }
}
```

```ts
import {
  loadMayConfig,
  resolveModelProfile,
  resolveProviderConfig,
} from "@may/config";

const config = await loadMayConfig();
const deepseek = resolveProviderConfig(config, "deepseek");
const selectedModel = resolveModelProfile(config);
```

By default, `loadMayConfig()` reads `~/.may/config.json`. Pass `{ path }` to
load another file. Existing provider entries containing `apiKey`, `baseURL`, and
`model` remain supported; `models` and `defaultModel` are optional.
`contextWindowTokens` and `maxOutputTokens` are optional positive integers.
They can be set on a provider or overridden by a model profile.

`apps` is an optional map of application-owned configuration. This package
validates that each entry is an object but leaves fields such as
`instructionsDirectory` for the application to interpret.

`apiKeyEnv` is resolved only when `resolveProviderConfig()` or
`resolveModelProfile()` selects that provider. The package does not instantiate
models, log configuration, or become a dependency of `@may/core`.
