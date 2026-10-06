# Model capabilities and execution diagnostics

**English** | [简体中文](../../zh-CN/guides/model-telemetry-integration.md)

## Configure a validated model and local diagnostics

Use the same resolver for inspection and model creation. Existing configuration
supplies model identities, provider connections, and capability declarations.
The observability plugin owns its processor and closes it with the application.

```ts
import { defineAgent } from "@may/application";
import { loadMayConfig } from "@may/config";
import { createBuiltinProviderAdapterRegistry, createModelCapabilityResolver,
  selectProviderModel } from "@may/providers";
import { createObservabilityPlugin, observabilityService } from "@may/plugin-observability";

const config = await loadMayConfig({ path: "./may.config.json" });
const selection = selectProviderModel(config);
const resolver = createModelCapabilityResolver();
const registry = createBuiltinProviderAdapterRegistry({ resolver });
const capabilities = await resolver.resolve(selection);
const model = registry.create(selection);
const definition = defineAgent({
  model,
  permissionPolicy: () => "deny",
  plugins: [createObservabilityPlugin({ dataDirectory: "./data", samplingRatio: 0.1 })],
  traceAttributes: {
    "may.configuration.version": "agent-policy-2",
    "may.context.policy_version": "context-policy-3",
    "may.budget.policy_version": "budget-policy-1",
  },
});
const application = await definition.open();
const run = await application.submit({ input: "Describe the project." });
await run.result;
const telemetry = application.getService(observabilityService);
const result = telemetry.diagnostics!.getDiagnostics({ sessionId: application.sessionId, limit: 40 });
const metrics = telemetry.metrics!.getMetrics();
const delivery = telemetry.processor.getDiagnostics();
await application.close();
```

Policy versions above identify host-owned immutable policies. Keep the actual
policy definitions and evaluator evidence in host storage. The returned
capability snapshot is separate from verification records. Resolver refresh
queries metadata; it does not send a demonstration prompt or spend model tokens.

## Capability and request decisions

Each field has a known value, an explicit unsupported state, or an unknown
state. Model, adapter and connection declarations constrain the effective
result. Adapter transport support alone cannot prove model support. User model
declarations take priority within the model layer. Connection declarations can
further restrict that model. The `layers`, `version`, timestamps, declaration
source, and discovery diagnostics remain available to consumers.

Before a built-in model sends the inference request, its wrapper checks content
types and sources, declared image/attachment limits, available MIME information,
reasoning effort, parameter schemas, and response format constraints. Hosts can
provide `estimatedInputTokens` and media metadata to validate limits whose
measurement requires external information. Unknown measurements stay explicit.
`options.unknownCapabilityPolicy: "require-known"` requires known support;
the default `allow` permits unknown fields and exposes validation issues.

`ModelRequest.responseFormat` selects JSON or named JSON Schema output. OpenAI
Responses and Chat Completions send native format fields. Unsupported transports
reject requests before sending. Ajv validates supported schema dialects and the
final value. A schema failure terminates the request without changing the
model, parameters, schema, or user content. Direct custom registries opt into
validation through `validateRequests` or `createCapabilityValidatedModel`.

Once a provider has returned a final response, `ModelResponseValidationError`
preserves its completion state and known usage. Output validation failure still
contributes to budgets, cost and telemetry. Invalid output does not enter Context
or start tools; unavailable usage remains unknown.

Resolver cache TTL, entry limits, concurrent discovery deduplication, and
explicit refresh are configurable. Verification records retain the exact
observed request parameters and a bounded connection identity; they never
automatically expand a capability declaration. See the
[configuration reference](../reference/configuration.md).

## Usage, cost and budgets

Usage records distinguish cached reads, cached writes, reasoning and additional
items, with their inclusion relationships and completeness. Run budgets and
shared budgets use the same versioned pricing result. Estimated cost and a
provider-reported amount retain their separate `kind`, currency, source and
completeness. Configure current host-approved prices; the library does not
silently fetch or invent a tariff. Missing counts, unknown inclusion
relationships and missing rates remain visible.

`maxCostUsd` requires complete USD pricing. A provider may report usage only
after accepting a request, so response-time enforcement cannot reverse that
request's charge. See [Run budgets](run-budgets.md) and
[shared budgets](coordination-resources.md).

## Tasks, continuation and remote execution

`TelemetryCorrelation` carries `version: 1`, task, coordination, dispatch,
scheduler execution and previous Run identities, plus an optional parent trace.
It validates identifiers and rejects content or credentials. Coordination
passes it into ApplicationAgent and May adapters. Remote workers validate it
before executing and exclude it from business request fingerprints. Scheduler
provides it when telemetry is enabled; host dispatchers propagate it and keep
their own durable deduplication. Session continuation creates a fresh Run and
records `may.run.resumed_from` from its previous Run, including after reopening.

A logical `may.model.call` contains independent `may.model.attempt` records.
First content and first text latency are separate; absent output retains absent
latency. Cancellation, protocol failure and completion status remain independent
of output presence. Each concurrent task shows its own duration and identity.

## Diagnostics, metrics and acceptance

Local diagnostics retain all observed spans, including spans not selected for
remote export, within configured count and retention limits. Filters and pages
use task, Session, Run or trace identity. Export queues have bounded capacity,
timeouts and failure/drop counters. Metrics count runs, calls, attempts, tools,
token usage, cost and latency independently of trace sampling, with bounded
series and permitted labels. Official OpenTelemetry adapters export both traces
and metrics over OTLP HTTP. See [observability](observability.md).

The host can call `recordAssessment` with evaluator/version, task identity,
`passed`, `failed` or `inconclusive`, configuration version and evidence
references. The host authorizes diagnostic and evidence access. Operational
success and task acceptance are separately recorded.

MaybeCode displays model capabilities and active Session diagnostics. MaybeClaw
exposes authenticated model inspection and selected Session diagnostics through
its existing management commands. `createTelemetryPanel` supplies a shared
presentation with parent identity, separate durations and retention coverage.
See [Shared Web UI](web-ui.md).

## Verification commands

```powershell
pnpm build
pnpm test
pnpm docs:check
pnpm test:package:plugin
pnpm test:package:scheduler
pnpm test:package:maybecode -- --directory E:\code\may-model-telemetry-smoke
pnpm test:integration:model-telemetry
```

The live integration command uses the host's configured default model and its
provider quota for one inference request. OpenAI transports also exercise native
JSON Schema output. It validates actual usage, capability version, attempt
parentage and independent metrics. Reports and Session history remain under
ignored `review/model-telemetry-live/`. Local protocol, SQLite, file and process
tests do not require an external model account.
