# Compatibility and stability

**English** | [简体中文](../../zh-CN/reference/compatibility.md)

May is currently a developer-preview framework. All workspace packages are at
`0.1.0`; the repository does not yet promise long-term source, binary, wire or
persistence compatibility.

This page describes the boundary callers can rely on today and the changes
they must still plan for.

## Public API boundary

Only entry points declared in a package's `exports` map are public. Importing a
file from `src/`, `dist/` or another undeclared deep path is unsupported even
when that file happens to exist locally.

Prefer type-only imports for contracts and dependency injection over reaching
into an implementation:

```ts
import {
  AgentApplication,
  type AgentApplicationEvent,
} from "@may/application";
import type { ContextFactory } from "@may/context";
```

The current APIs may change before `1.0.0`. When an API is renamed, May should
prefer a documented deprecated alias or an adapter when doing so is practical,
but preview consumers must still review release notes and compile their code
against each upgrade.

### Composition objects

`ToolRegistry`, `DuplicateToolNameError`, `AgentDefinition`, and
`defineAgent()` are public through their package root exports, but remain
developer-preview APIs under the same `0.1.0` policy.

Their current ownership contract is explicit:

- registries are ordinary instances, never process-global state;
- `May` consumes and snapshots an `Iterable<Tool>` in its constructor;
- `AgentDefinition` consumes and snapshots its tool iterable when the
  definition is created;
- direct `AgentApplication.open()` snapshots its iterable while opening; and
- collection snapshots preserve original Tool identity rather than cloning
  executable code or stateful collaborators.

`Tool.name`, `Tool.description`, and `Tool.inputSchema` are readonly in
TypeScript. A `ToolRegistry` records those values/references plus the parser
and executor, and throws `TypeError` from operations that expose tools or
definitions if one later changes. This is intentionally a shallow guard, not
a deep clone or freeze of the schema object.

Each `AgentDefinition.open()` creates an independent application and Session
lifecycle. It does not clone a captured Model, Context factory, Tool executor,
Tool scheduler, policy closure, or Tool object. Callers must therefore treat
those objects as shared and provide isolation when opening applications
concurrently.

The framework does not currently persist or discover Agent definitions.
Session history and metadata are not a serialized definition, and resume still
applies the behavior and policy supplied by the current process.

### Tracing contracts

Core's `Tracer`, `TraceSpan`, `TraceContext`, attributes, and propagation
fields are public preview contracts. `@may/observability` processors,
exporters, sampling functions, completed-span shape, span names, and attribute
names are also preview APIs and may evolve before `1.0.0`.

Tracing is deliberately fail-open and non-durable. It may be sampled or
dropped, so callers must not use spans as Session, permission, billing, or
security audit truth. Built-in instrumentation excludes prompts, messages,
reasoning, and tool input/output; caller-supplied attributes have no automatic
redaction and must be bounded and non-sensitive.

Tracer and processor lifetime is caller-owned. Closing an `AgentApplication`
does not flush or shut down a shared processor; the product must do that once
at its real ownership boundary.

## Events

Run and permission streams are live observation channels. High-volume
streaming deltas may be dropped from bounded queues when a consumer is too
slow; terminal lifecycle events, returned Run results and durable Session facts
must not depend on retaining every delta.

Consumers must handle unknown future event variants defensively. Persisted
application presentation data uses a `kind` plus numeric `version`; decoders
should reject unsupported versions without corrupting the Session.

The coding change-preview decoder intentionally reads the historical
`maybecode.change-preview` kind. That wire name is retained for existing
Session compatibility and should not be interpreted as a dependency from the
framework package back to the MaybeCode application.

## Session persistence

The file-backed Session store uses append-oriented JSONL, and the file-backed
Catalog is a lightweight local index. They are currently intended for local
development and a single active writer per session, not distributed or
multi-host coordination.

The following are not yet stable storage contracts:

- exact JSON field layout and optional fields;
- on-disk directory naming;
- migration across arbitrary future versions;
- crash recovery guarantees beyond the behavior covered by current tests;
- concurrent writes from multiple processes or hosts.

Do not edit the files manually. Applications that require a stable external
schema should implement a `SessionStore` and `SessionCatalog` behind the public
interfaces and own their migration policy. See
[Custom storage](../guides/custom-storage.md).

## Provider-owned state

Provider adapters may attach opaque `modelState` to normalized messages so a
later request can continue a provider-native conversation or compaction. Only
the adapter that created that state should interpret it. Other adapters must
fall back to normalized May messages rather than assuming a foreign wire
format.

Provider HTTP APIs and model capabilities change independently from May.
Applications should resolve capabilities instead of guessing them from model
names, and should treat an unknown capability as unknown.

## Security boundary

Permission approval is not execution isolation. In particular,
`@may/coding-tools` shell execution runs with the privileges of the May process.
Applications processing untrusted instructions or commands need a separate
sandbox or remote execution backend.

Configuration and Session files may contain sensitive prompts, tool input,
tool output and provider data. The built-in local stores do not encrypt them.

## Supported runtime

Current packages declare Node.js 20 or newer. The repository uses pnpm and
TypeScript project references for development. Provider integration tests that
make real network requests are opt-in; the regular test suite is offline.

## Before a stable release

Before declaring `1.0.0`, the project should explicitly version and document:

1. exported TypeScript contracts;
2. durable Session and Catalog migrations;
3. persisted presentation kinds;
4. event evolution rules;
5. supported Node.js and provider-adapter versions;
6. tracing span/attribute evolution and exporter compatibility; and
7. deprecation and release-note policy.
