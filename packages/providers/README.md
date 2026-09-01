# `@may/providers`

Unified provider composition for May. This package owns model-profile
selection, adapter registration, built-in adapter configuration, and model construction. It does
not add provider-specific behavior to `@may/core` or provider knowledge to
`@may/config`.

## Built-in adapters

- `deepseek-chat` → `@may/provider-deepseek`
- `zhipu-chat` → `@may/provider-zhipu`
- `kimi-chat` → `@may/provider-kimi`
- `anthropic-messages` → `@may/provider-anthropic`
- `openai-responses` → `@may/provider-openai`
- `openai-chat-completions` → `@may/provider-openai-compatible`

```ts
import {
  createBuiltinProviderAdapterRegistry,
  selectProviderModel,
} from "@may/providers";

const selection = selectProviderModel(config, { model: "reasoner" });
const model = createBuiltinProviderAdapterRegistry().create(selection);
```

The built-in factories validate provider-specific options and preserve generic
model limits and optional capabilities such as OpenAI Responses compaction.

## Model capability resolution

`createModelCapabilityResolver()` resolves model-specific reasoning efforts in
this order: explicit model-profile metadata, enhanced provider discovery,
May's vendor-documented built-in catalog, then `unknown`. Its default provider
discovery understands CLIProxyAPI's enriched Codex response from
`/v1/models?client_version=...`; ordinary OpenAI model-list responses do not
contain enough information and are ignored.

```ts
import { createModelCapabilityResolver } from "@may/providers";

const capabilities = await createModelCapabilityResolver().resolve(selection);
if (capabilities.reasoningEffort.status === "known") {
  console.log(capabilities.reasoningEffort.efforts);
}
```

Applications should display `unknown` rather than treating an adapter's full
protocol union as proof that a particular model supports every value.

Provider IDs come from configuration and do not participate in adapter lookup.
A model profile may override the provider's default adapter.

## Custom adapters

Registries are ordinary instances; there is no process-global registry.

```ts
import { ProviderAdapterRegistry } from "@may/providers";

const registry = new ProviderAdapterRegistry();
registry.register("custom-protocol", {
  create(selection) {
    return new CustomModel(selection.model, selection.providerConfig);
  },
});

const model = registry.create(selection);
```

MaybeCode and May CLI accept an injected adapter registry. Configuration may
create any number of provider connections from registered adapters; it does
not import executable adapter modules.

The package also re-exports the public APIs of the built-in provider adapter
packages for convenience. The individual packages remain independently
usable when an application does not want the built-in composition layer.
