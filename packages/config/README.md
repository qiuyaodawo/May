# `@may/config`

Optional configuration loading and validation for May applications.

```json
{
  "defaultModel": "deepseek-reasoner",
  "providers": {
    "deepseek": {
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com"
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

`apiKeyEnv` is resolved only when `resolveProviderConfig()` or
`resolveModelProfile()` selects that provider. The package does not instantiate
models, log configuration, or become a dependency of `@may/core`.
