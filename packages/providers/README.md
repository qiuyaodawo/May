# `@may/providers`

Unified provider composition for May. This package owns provider selection,
registration, built-in adapter configuration, and model construction. It does
not add provider-specific behavior to `@may/core` or provider knowledge to
`@may/config`.

## Built-in providers

- `deepseek` → `@may/provider-deepseek`
- `zhipu` or `glm` → `@may/provider-zhipu`
- `kimi` → `@may/provider-kimi`
- `anthropic` → `@may/provider-anthropic`
- `openai` → `@may/provider-openai`

```ts
import {
  createBuiltinProviderRegistry,
  selectProviderModel,
} from "@may/providers";

const selection = selectProviderModel(config, { model: "reasoner" });
const model = createBuiltinProviderRegistry().create(selection);
```

The built-in factories validate provider-specific options and preserve generic
model limits and optional capabilities such as OpenAI Responses compaction.

## Custom providers

Registries are ordinary instances; there is no process-global registry.

```ts
import { ProviderRegistry } from "@may/providers";

const registry = new ProviderRegistry();
registry.register("custom", {
  create(selection) {
    return new CustomModel(selection.model, selection.providerConfig);
  },
});

const model = registry.create(selection);
```

Applications can inject `selection => registry.create(selection)` through
their existing model factory seam.

The package also re-exports the public APIs of the built-in provider adapter
packages for convenience. The individual packages remain independently
usable when an application does not want the built-in composition layer.
