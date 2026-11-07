# API stability

**English** | [简体中文](../../zh-CN/reference/stability.md)

Use this reference when choosing public APIs and reviewing upgrades. See
[compatibility](compatibility.md) for runtime and storage limits.

## Stability levels

`stable` APIs carry `@public` on source declarations. During `0.x`, breaking
changes require a minor release and migration instructions. From `1.0`, breaking
changes require a major release. Compatible fixes use patch releases.

`experimental` APIs carry `@experimental`. They can change in minor releases;
changesets describe the changes and their consumer impact.

The stable core covers `Model`, `Tool`, `defineTool`, message and tool-result
types, `defineAgent`, `AgentDefinition`, basic `AgentApplication` lifecycle
(`open`, `submit`, `history`, `close`), Session creation, recovery, closure and
history reading, `SessionStore`, `PermissionPolicy`, approval types and plugin
resource disposal interfaces. Other APIs are experimental. The symbol records
define the precise boundary for each entrypoint.

## Persistent data and configuration

The file Session store validates JSONL event payloads, Session identity and
consecutive sequence numbers, and reconstructs supported history. Unknown event
types and invalid payloads are rejected. A trailing record without a terminating
newline is repaired as an incomplete write during ordinary reads. `inspect`
reads committed records without repair. The format has no global numeric schema
version. Runtime and presentation-data versions identify their respective payloads.

Restoring a Session compares its saved runtime descriptor with the current
runtime. A mismatch requires `migrateState`; without it, opening fails.
Restored state requires `restoreState`. Plugin state similarly checks
`stateVersion` and compatible plugin versions; incompatible saved state requires
the plugin's declared migration and is validated before use.

Application plugin snapshots and model-request records currently accept version
`1`. Catalog readers accept versions `1` and `2`. These readers reject unknown
versions; keeping the Session class stable preserves its documented lifecycle
API while each persisted format follows its own reader and migration rules.

Configuration uses JSON Schema validation and has no global numeric format
version. Unknown top-level properties are rejected. Application entries use the
application's validator. Adding a version field requires a corresponding format
change and reader support.

Before upgrading, stop all writers and preserve complete copies of Session and
configuration data. Follow the release's migration instructions, execute any
required migration, validate configuration and open existing Sessions with the
upgraded reader before resuming work. There is no general format-upgrade command.
Custom `SessionStore` implementations own their format versions and migrations;
versioned formats must reject unsupported versions. Persistent-format changes
require compatibility documentation and migration instructions with the changeset.

## Inspect the API boundary

[`scripts/api-stability.json`](../../../scripts/api-stability.json) records each
export's package, entrypoint, symbol, stability, introduction version and docs.
Lifecycle and resource members use `Class.member` symbol names.
[`api/`](../../../api/) contains API Extractor reports for typed entrypoints.
Other public resources have reports recording their target and content hash.
Root entrypoints use `index.api.md`; subpath separators use `__`. JSON and other
asset exports have no TypeScript symbols.

After building, `pnpm api:check` compares declarations with the reports and
validates stability records and TSDoc tags. For an intentional API change, update
the symbol records and declaration tags, build, run `pnpm api:update` and review
every report difference. See
[repository development](../guides/repository-development.md).
