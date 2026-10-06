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

`createModelCapabilityResolver()` resolves model capability fields and reasoning efforts in
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

`ModelCapabilities.fields` contains independent `known`, `unsupported`, or
`unknown` values with sources. `layers.model`, `layers.adapter`, and
`layers.connection` preserve the declarations contributing to effective
capabilities. Unsupported layers reject the operation. Array restrictions
intersect, numeric ceilings use the smallest known value, and parameter/schema
constraints all apply. Omitted connection fields impose no restrictions.
Unknown model support stays unknown while known adapter and connection
restrictions remain enforceable.

Fields cover text/image/audio/file/resource input, media source forms,
text/image/audio output, tools and tool-call counts, JSON and JSON Schema
output, schema dialects and constraints, Context/output token ceilings,
attachment counts/bytes/MIME types, parameter JSON Schema, native Context
compaction, and `reasoning.modes` for effort/budget/adaptive/thinking/summary
transport support. `reasoningEffort` retains its shape and source precedence.

Model-profile `capabilities.fields` override discovery field by field;
provider `capabilities.fields` declare connection restrictions. `false`
declares unsupported, `true` declares support, numbers declare ceilings,
arrays declare permitted values, and `parameters` /
`structuredOutput.schemaConstraint` hold synchronous JSON Schema. Declared
resource ceilings in `selection.limits` also have user priority.
The wrapper's `limits` getter uses the smallest available raw, configured,
connection and resolved ceiling. Configuration restrictions are available
synchronously; discovery restrictions are available after resolution. Hosts
should resolve capabilities before creating a Context controller when its
initial budget must use discovery metadata. Refreshing capabilities does not
reconfigure an existing Context controller's budget.

`resolve(selection, { fields, refresh: true })` supports targeted queries and
explicit refresh. Caches have a five-minute TTL and a 128-entry limit by
default, with concurrent identical queries shared. Changing connection
configuration, including credentials, changes its opaque hashed identity.
`invalidate(selection)` and `invalidate()` expire cached records. Discovery
failures appear in redacted `diagnostics` and are retried on the next query.
`observedAt`, `expiresAt`, and a content-derived `version` describe snapshots.
Custom discovery implements `discoverCapabilities` and/or the compatible
`discoverReasoningEffort` hook.

Built-in registries wrap models with request validation. Custom
`ProviderAdapterRegistry` enables this with `{ validateRequests: true }`;
`createCapabilityValidatedModel()` also wraps individual models. Pass a shared
`resolver` to share discovery and verification records. The wrapper exposes
`getModelCapabilities()`, `refreshCapabilities()`, `preflight()`, and
`lastValidation`. May and retry/budget wrappers execute preflight before a
physical attempt or reservation starts. Preflight updates capability versions
and diagnostics without sending a model request or recording successful
verification; streaming also validates requests for independent use.
Unknown requirements continue by default and are reported;
`unknownPolicy: "require-known"` rejects them. Profile
`options.unknownCapabilityPolicy` configures the same policy.

`validateModelRequest()` returns field-specific issues and
`assertModelRequestValid()` rejects invalid requests before execution. They
check input/source support, known resource ceilings, reasoning efforts,
parameter combinations and structured output. Hosts supply
`estimatedInputTokens` and `mediaMetadata` for external token estimates,
attachment sizes and MIME types. Base64 bytes are measured locally; unavailable
external metadata stays unknown. Non-empty provider parameters require a known
`parameters` scope in strict workflows. Context limits compare estimated input
tokens plus the requested output token reservation; missing estimates or
reservations stay unknown. Native Context compaction uses the same input
validation and checks `contextCompaction` before execution.

`ModelRequest.responseFormat` accepts `{ type: "json" }` or
`{ type: "jsonSchema", name, schema, strict? }`; profile
`options.responseFormat` supplies a default. Request formats take priority.
OpenAI Responses serializes `text.format`, and OpenAI Chat Completions
serializes `response_format`. Independent adapters validate configuration and
final responses. Ajv and ajv-formats validate draft-07 or 2020-12; asynchronous
schemas and unavailable references fail before sending. Provider schema scope
stays unknown unless `structuredOutput.schemaConstraint` declares it.
Tool-call responses allow an intermediate empty body.
Final JSON/schema or tool-call limit failures throw
`ModelResponseValidationError` with the observed response receipt. The error
preserves Usage/cost and physical completion for runtime, budget and attempt
accounting. Retry wrappers do not retry a completed validation failure;
invalid response content stays unavailable to tools and Context.

`verificationRecords(selection)` returns a bounded history separate from
declarations. Records include connection, model, capability, time, selected
reasoning/output limits, schema digest and result. Media records include the
observed count, source forms, available byte ranges and a MIME-set digest.
Evidence distinguishes `request-accepted`, `response-validated`, and `failed`;
each record applies to its observed request parameters. Records do not promote
declared support or store request content or credentials.

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
