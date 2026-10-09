# Compatibility and stability

**English** | [简体中文](../../zh-CN/reference/compatibility.md)

May is a developer-preview framework. Public APIs, protocol representations and
storage formats can change before `1.0.0`. Read release notes and compile consumers
against each upgrade. This reference describes current compatibility boundaries.

## Supported runtime

Published framework packages require Node.js 22 or newer. MaybeClaw requires
Node.js 22.13 or newer. Repository development requires Node.js 22.16.0 or newer
for the `node:sqlite` backup APIs used by the offline suite. The repository declares
pnpm 12.4.2 in `package.json` and recommends Node.js 24 in `.node-version`.

CI covers Linux on Node.js 22/24 and Windows/macOS on 24. Package installation
checks cover Linux and Windows. Check the workflow and the target package's
`engines` when choosing a deployment environment. See
[repository development](../guides/repository-development.md) for verification commands.

## Public API boundary

Import only entry points declared in the package's `exports` map. Undeclared
paths under `src/` or `dist/` are implementation details. Use type-only imports
when importing types:

```ts
import { AgentApplication, type AgentApplicationEvent } from "@may/application";
import type { ContextFactory } from "@may/context";
```

The [package catalog](packages.md) identifies responsibilities and public entry
points. Deprecated aliases, when available, are documented individually; preview
consumers should check each release for migration requirements.

### Composition objects

`ToolRegistry`, `DuplicateToolNameError`, `AgentDefinition` and `defineAgent()`
are public preview APIs. Their ownership rules are:

- A registry is an instance owned by its caller.
- `May` captures static tool membership during construction.
- `AgentDefinition` captures static tool membership when the definition is created.
- Direct `AgentApplication.open()` captures static membership while opening.
- Ordinary registry lookup and `clone()` preserve the original Tool objects.
- Registry operations that expose tools or definitions check registered name,
  description, schema reference, parser, executor, `resultContent` and
  `permissionVersion` for replacement. Replacing
  these fields causes `TypeError`. This check compares schema identity; mutation
  inside that schema must be managed by the caller.

Each `AgentDefinition.open()` creates a separate application and Session lifecycle.
Captured Models, Context factories, executors, schedulers, policy closures and
stateful collaborators remain caller-owned. Provide concurrency isolation for
shared objects. Definitions are reconstructed by the application; Session history
and metadata do not serialize their behavior or current permission policy.

### Per-Run dynamic tool catalogs

`MayOptions.toolSource` is a trusted synchronous `() => Iterable<Tool>`, also
accepted by `AgentApplication`, `defineAgent()` and `MaybeCodeApplication`. It adds
tools to the static collection once at each `run()` or `continue()` start. Discover
or refresh remote tools outside Core, then return the latest in-memory collection.
Duplicate names fail before Context mutation.

`ToolRegistry.snapshot()` captures frozen Tool facades and deep-copied, frozen
schemas. A Run uses one snapshot for model definitions, scheduling, parsing,
permissions and execution. Model-facing schemas are separate copies. Catalog
changes affect the next Run. Executors receive the Run facade, so put host metadata
in Tool fields when execution needs it. An identity-keyed WeakMap containing only
the original object will not identify the facade. Captured callbacks retain their
original `this`; closure state remains shared. Schemas must support structured cloning.

`Tool.permissionVersion` is optional host-owned identity excluded from model
definitions. Session grants bind the policy's `grantKey` to canonical name,
description, schema and this version. A changed definition or host identity needs
new approval. Schema key order alone does not invalidate a grant.
`revokeSessionGrant(key)` revokes every version for the key; explicit policy denial
takes precedence. Include execution-affecting metadata, endpoint and account in
the host's version. See [permission policies](../guides/permission-policy.md).

## Events and presentation data

Run and permission streams carry live observations. Bounded queues can drop
high-frequency streaming deltas when consumers are slow. Use terminal lifecycle
events, Run results and durable Session history for completion and saved facts.
See [events](../concepts/events.md).

Consumers must handle unknown event variants. Persisted application presentation
data uses `kind` and numeric `version`; reject unsupported versions without
modifying the Session. The change-preview decoder recognizes
`maybecode.change-preview` for existing saved data. The name is a persisted format
identifier; package dependency direction is defined by the package imports.

## Session persistence

The file Session store uses append-oriented JSONL and requires one active writer
per Session. The file Catalog is a local index using atomic append-only operation
files across local processes. Its offline `compact({ confirmHostsStopped: true })`
requires other Catalog users to be stopped. Exact field layouts, optional fields,
directory naming and migration across future versions remain preview formats.
Recovery guarantees are limited to the implementation's verified behavior.

Use the public storage APIs to change records. Applications that need an external
schema must implement `SessionStore` and `SessionCatalog` and own their migration
policy. See [custom storage](../guides/custom-storage.md) and
[recovery](../guides/recovery.md).

## Provider-owned state

Adapters can attach opaque `modelState` to normalized messages to continue
provider-native conversations or compaction. The creating adapter interprets that
state. A different adapter uses normalized May messages. Resolve model capabilities
through the provider catalog; an unknown capability remains unknown.

Provider HTTP APIs and model capabilities evolve independently. Use the
[configuration reference](configuration.md) for declared overrides and capability policy.

## Coordination and teams

`@may/coordination` APIs, version-1 snapshot journals, optional resource journals
and the remote worker protocol are preview formats. A single durable coordinator
owns scheduling, including remote leaf work. Local budget reservations and
accounting apply within that coordinator. Changes to saved policies and limits
require explicit handling during recovery.

MaybeCode teams use local Agents and default to read-only work. Version 2 adds
saved plans, scoped checks/reports and confirmed recovery. Coding mode allows
private-copy edits; applying a patch to source requires review and exact host
confirmation. Authorized check processes use the host operating-system privileges.
Version 1 teams retain their read-only resume/status/cancel behavior.

See [coordination](../guides/coordination.md),
[resources](../guides/coordination-resources.md),
[attempts and revisions](../guides/coordination-lifecycle.md),
[remote workers](../guides/coordination-remote.md) and
[MaybeCode teams](../guides/maybecode-team.md) for concurrency and recovery limits.

## MCP

`@may/mcp` pool options, errors, namespacing, output representations, status,
lifecycle events and span names are preview APIs. Tool clients support stdio and
Streamable HTTP, explicit refresh/reconnect and per-Run catalogs. Host-selected
resources, templates and prompts enter the conversation as user content.

Model-facing names use `mcp__<server>__<tool>`, provider-safe normalization and a
64-character limit. Saved calls retain those names. Changing a server ID or remote
tool name can leave historical calls without a corresponding executable tool.

The interaction broker manages modern form/URL elicitation with owner scopes,
bounded waits, response validation and identity checks before continuation. Legacy
interactive operations use explicitly isolated connections. Roots/Sampling, Tasks,
Apps Host and the independent `@may/mcp/server` export require their own opt-in
configuration and services. See [MCP](../guides/mcp.md),
[long-running tasks](../guides/mcp-tasks.md), [Apps](../guides/mcp-apps.md) and
[server authoring](../guides/mcp-server.md) for supported protocols and host duties.

## Tracing

Core tracing types and `@may/observability` processors, exporters, sampling,
completed-span shapes, names and attributes are preview APIs. Traces may be sampled
or discarded, including when an exporter saves spans. Use Session records and
application-owned records for permission, billing and audit decisions.

Built-in instrumentation excludes prompts, messages, reasoning and tool input/output.
Caller-supplied attributes have no automatic redaction and must be bounded and
non-sensitive. The caller owns tracer and processor lifetime; close shared
processors at their ownership boundary. Closing an application does not close them.

MaybeCode's daily trace JSONL rotates by local calendar date and defaults to
60 days of retention. Its span format remains preview telemetry. See
[observability](../guides/observability.md).

## Security boundary

Permission approval controls whether a Tool can execute. Coding shell Tools run
with the May process's privileges. Use a separate sandbox or remote execution
backend when the application must contain untrusted commands.

Configuration and Session records can contain sensitive prompts, Tool data and
provider state. Built-in local Session stores do not encrypt these records.

## Stable-release requirements

Before declaring `1.0.0`, version and document exported APIs, Session/Catalog
migrations, presentation kinds, event evolution, supported Node.js and adapter
versions, tracing/exporter compatibility, and deprecation/release-note policy.
