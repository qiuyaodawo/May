# May configuration reference

**English** | [简体中文](../../zh-CN/reference/configuration.md)

May reads `~/.may/config.json` by default. The configuration separates named
provider connections, selectable model profiles, and application settings.

Use this page to look up fields and defaults. For application startup and controls,
see [MaybeCode](../guides/maybecode.md) or [MaybeClaw](../guides/maybeclaw.md).

For editor completion and validation, associate the file with
[`packages/config/may-config.schema.json`](../../../packages/config/may-config.schema.json).
For example, on this Windows checkout the user configuration can start with:

```json
{
  "$schema": "file:///E:/code/May/packages/config/may-config.schema.json",
  "providers": {},
  "models": {}
}
```

The exact file URL depends on the checkout location. Editors also allow mapping
`~/.may/config.json` to the schema in workspace
settings without adding `$schema` to the file.

## Top-level fields

| Field | Required | Description |
| --- | --- | --- |
| `providers` | yes | Named connections containing an adapter, credentials, endpoint, and shared options. |
| `models` | no | Named model profiles shown by model selectors such as MaybeCode `/model`. |
| `defaultModel` | no | The model profile selected when no explicit model is supplied; MaybeCode `/model` can update it. |
| `apps` | no | Application-owned settings. |

Provider fields are `adapter`, `apiKey`, `apiKeyEnv`, `baseURL`, and `options`.
Do not set both `apiKey` and `apiKeyEnv`. Model fields are `provider`, optional
`adapter`, `model`, `contextWindowTokens`, `maxOutputTokens`, `options`, and
`capabilities`.
When a model omits `adapter`, it inherits the provider adapter. Provider options
and model options are shallow-merged, with model values taking precedence.

Prefer `apiKeyEnv` over embedding secrets in JSON:

```json
{
  "providers": {
    "cliproxy": {
      "adapter": "openai-responses",
      "apiKeyEnv": "CLIPROXY_API_KEY",
      "baseURL": "http://127.0.0.1:8317/v1",
      "options": { "store": false }
    }
  },
  "models": {
    "cliproxy-high": {
      "provider": "cliproxy",
      "model": "model-id-from-v1-models",
      "options": { "reasoningEffort": "high" }
    }
  },
  "defaultModel": "cliproxy-high"
}
```

MaybeCode's model picker can persist a different `defaultModel`. It rereads and
validates the loaded file, updates only that top-level field, and replaces the
file atomically. Setting the default does not switch the active model unless
the command form `/model <profile-prefix> --default` is used.

## Built-in adapter options

`options` is adapter-specific. The built-in registry currently recognizes:

| Adapter | Options |
| --- | --- |
| `openai-responses` | `maxOutputTokens`, `reasoningEffort`, `reasoningSummary`, `serverCompactThreshold`, `store`, `responseFormat` |
| `openai-chat-completions` | `maxOutputTokens`, `reasoningEffort`, `store`, `responseFormat` |
| `deepseek-chat` | `thinking`, `reasoningEffort`, `maxTokens` |
| `zhipu-chat` | `thinking`, `clearThinking`, `reasoningEffort`, `maxTokens` |
| `kimi-chat` | `thinking`, `reasoningEffort`, `maxTokens` |
| `anthropic-messages` | `thinking`, `reasoningEffort`, `maxTokens`, `apiVersion` |

Common scalar values:

- All adapters accept `unknownCapabilityPolicy`: `allow` (default) or `require-known`.
- `reasoningEffort` is a non-empty model-specific string. The adapter only
  serializes the selected value; model capability metadata determines the
  choices shown by MaybeCode. This also lets enhanced compatible providers add
  a level without waiting for a new adapter release.
- OpenAI `reasoningSummary`: `auto`, `concise`, or `detailed`.
- Token limits and `serverCompactThreshold` are positive integers.

The adapter validates option shapes when the model is instantiated. It does not
treat a protocol-wide reasoning union as proof of support by a specific model.

## Model capabilities

May resolves model-specific capabilities separately from the adapter's broad
protocol-level option validation. The resolution order is:

1. A model profile's explicit `capabilities` override.
2. An enhanced provider model endpoint. For OpenAI-compatible connections,
   May recognizes CLIProxyAPI's Codex catalog at
   `/v1/models?client_version=...` and reads `supported_reasoning_levels`.
3. May's built-in model catalog, maintained from vendor documentation.
4. `unknown` when no reliable source describes the model.

The standard OpenAI `/v1/models` response only identifies models. Capability
snapshots include redacted discovery diagnostics and a bounded cache with
explicit refresh; unavailable fields stay `unknown`.

Override incorrect or missing metadata on a model profile:

```json
{
  "models": {
    "private-model": {
      "provider": "private-endpoint",
      "model": "private-reasoner",
      "capabilities": {
        "reasoning": {
          "efforts": ["low", "medium", "high"],
          "defaultEffort": "medium"
        }
      }
    },
    "non-reasoning-model": {
      "provider": "private-endpoint",
      "model": "private-chat",
      "capabilities": { "reasoning": false }
    }
  }
}
```

`defaultEffort` must be one of `efforts`. An explicit override always wins,
including over a provider's enhanced catalog.

### Capability field declarations

Capabilities accept independent `fields` declarations on model profiles and
provider connections. Profile fields override model metadata; provider fields
restrict the connection. Effective support considers model, adapter, and
connection. `false` disables a capability, and unsupported layers reject a
request before sending. Omitted connection fields impose no restrictions.

```json
{
  "capabilities": {
    "fields": {
      "input.text": true,
      "input.image": true,
      "input.image.sources": ["url", "base64"],
      "maxImages": 4,
      "maxAttachmentBytes": 10485760,
      "structuredOutput.jsonSchema": true,
      "structuredOutput.schemaDialects": ["draft-07"],
      "structuredOutput.schemaConstraint": { "type": "object" }
    }
  },
  "options": {
    "unknownCapabilityPolicy": "require-known",
    "responseFormat": {
      "type": "jsonSchema",
      "name": "answer",
      "strict": true,
      "schema": {
        "type": "object",
        "properties": { "answer": { "type": "string" } },
        "required": ["answer"],
        "additionalProperties": false
      }
    }
  }
}
```

This object is a model-profile fragment. `unknownCapabilityPolicy` defaults to
`allow`; `require-known` rejects unknown requirements. Input sources, sizes and
MIME types have separate constraints; external metadata may need to be supplied
by the host. `options.responseFormat` supplies the default format for OpenAI
Responses and Chat Completions. Accepted formats are `json` and `jsonSchema`
(`name`, `schema`, optional `strict`). Ajv validates draft-07 and 2020-12 schemas
and final output. Tool-call responses allow intermediate empty bodies.
`structuredOutput.schemaConstraint` describes provider-specific schema scope.

Other fields include `input.audio`, `input.file`, `input.resource`,
`input.audio.sources`, `input.file.sources`, `output.text`, `output.image`,
`output.audio`, `tools`, `tools.maxCalls`, `structuredOutput.json`,
`structuredOutput.schemaDialects`, `contextWindowTokens`, `maxOutputTokens`,
`maxAttachments`, `fileTypes`, `parameters`, `contextCompaction`, and
`reasoning.modes`. Numbers are
positive safe integer ceilings, arrays contain permitted values, and
`parameters` / `structuredOutput.schemaConstraint` are synchronous JSON Schema
constraints. `tools.maxCalls` limits calls in a model response. The API exposes
sources, layer declarations, snapshot versions/times, targeted refresh and
bounded verification records. Non-empty provider parameters require known
`parameters` constraints under `require-known`. `reasoning.modes` describes
permitted `effort`, `budget`, `adaptive`, `thinking`, or `summary` modes.
Context checks include the input token estimate and requested output token
reservation; unavailable estimates or reservations remain unknown. Native
Context compaction checks its own capability and input support. Verification
records state `request-accepted`, `response-validated`, or `failed`, with media
counts, source forms and observed byte ranges, without storing content.
### Request and response validation

`Model.preflight` exposes request validation to May and model wrappers before
physical attempts and budget reservations. Rejected requests produce zero
physical attempt records.
Model wrappers expose the smallest known `limits` from model and connection
declarations. Discovery limits become available after capability resolution;
resolve before Context controller creation to use them in its initial budget.
Capability refresh does not reconfigure an existing Context budget. Profile
output limits also participate in preflight as actual output reservations.
Final JSON/schema validation failures throw `ModelResponseValidationError`
with `responseCompleted: true` and the received Usage/cost receipt. Runtime,
budget and attempt accounting preserve physical completion and actual usage;
retry wrappers do not retry these completed responses. Validation messages
contain fixed descriptions and exclude response content.

### Built-in reasoning catalog

The built-in reasoning catalog is maintained in
[`packages/providers/src/capabilities.ts`](../../../packages/providers/src/capabilities.ts).
Use explicit capability overrides or endpoint discovery for a model absent from
that catalog. Confirm the selected options against the account's supported model API.

### Thinking objects

These objects belong in provider or model `options`. Select the structure for
the adapter being used.

Kimi uses an object:

```json
{ "thinking": { "type": "enabled", "keep": "all" } }
```

Anthropic accepts disabled, adaptive, or explicitly budgeted thinking:

```json
{
  "thinking": {
    "type": "enabled",
    "budgetTokens": 8192,
    "display": "summarized"
  }
}
```

## Application plugins

MaybeCode accepts `apps.maybecode.plugins`; MaybeClaw May Agents accept
`apps.maybeclaw.agents[].plugins`. Each entry contains a local module or installed
package specifier, optional export name, configuration, and enabled flag. Resolution
uses the configuration file's directory. See [Plugins](../guides/plugins.md).

## MaybeCode project Git management

`apps.maybecode.git` defaults to `{}`. Set it to `false` to disable project Git
management. Object fields are `autoCommit` (default `true`), `readOnly` (default
`false`), `dataRoot`, `worktreesRoot`, and `excludedPaths` (project paths).
Paths resolve from the configuration file's directory. Metadata and worktree roots
must be outside the repository. Existing repositories are reused; new projects
receive a repository and initial checkpoint. Complete requests can create commits
using project ignore rules.

`autoCommit: false` preserves Git observation and existing-version checkpoints
while leaving edits uncommitted. `readOnly: true` prevents Git initialization and
mutation and denies project-changing built-in tools. Headless hosts can require
commit approval through `git.authorizeCommit`. Tool approval mode is a separate
setting. See [Git workspaces](../guides/git-workspaces.md) for forks and restoration.

## MaybeCode permission mode

`apps.maybecode.permissionMode` accepts `"default"` (default) or `"yolo"`.
YOLO auto-approves tool requests while retaining explicit policy denials.
`--yolo` and `--no-yolo` override configuration; using both fails validation.
`/yolo` and `/yolo on` enable the mode, `/yolo off` disables it, and `/yolo status`
queries it. Pause or cancel active Runs, goals, and MCP operations before changing
the mode. The current workspace host retains the mode through Session and model
changes. Startup options determine it after a restart; it is not saved in history
or configuration. `/goal` uses the current mode.

The terminal and Web UI show **YOLO · Auto-approve**, with English notifications.
Web UI uses `UiSnapshot.badges`; classic terminals update the prompt through
`TerminalIO.updatePrompt` while preserving drafts and cursors. Tool validation,
cancellation, and records remain active. MCP user-input requests require answers.
Shell commands use host-account authority. Team authorization is configured separately.

`apps.maybecode.persistentRules` defaults to `false`. When enabled, `edit` and
`write` grants use `.may/permission-rules.json` in the active project and show
the canonical file path at approval. Scope includes local user, project/worktree,
and main Agent; changing Session or model preserves matching rules. The host holds
the single-writer lock until shutdown. Rule and lock files are excluded from Git
checkpoints. `/permissions [list|allow <id>|deny <id>|revoke <id>]` and Web UI manage
existing ranges. Rules record an operator, and deny takes precedence.
`openConfiguredMaybeCode({ persistentRules })` overrides configuration. See
[Permission policies](../guides/permission-policy.md).

## MaybeCode settings

`apps.maybecode` recognizes:

- `skills`: `false` or `{ "directories": ["./skills"] }`; see
  [Skills discovery and paths](../guides/skills.md).
- `runBudget`: per-Run duration, Step, model/tool-call, token, and estimated cost
  limits; see [Run budgets](../guides/run-budgets.md).
- `subagents`: enabled by default; `false` or `{ "enabled": false }` disables it.
  Fields include `roles` (`model`, `reasoningEffort`, `instructions`, `tools`,
  `delegateTo`, `runBudget`), `defaultRole`, `limits` (`maxConcurrent`, `maxTasks`,
  `maxDepth`, `maxTaskTurns`, `maxDurationMs`, `maxInputBytes`, `maxOutputBytes`),
  child `runBudget`, and request limits `maxModelCalls`, `maxTotalTokens`,
  `reservationTokens`. Without `roles`, the `worker` role is registered. See
  [Subagent delegation](../guides/subagent-delegation.md).

`autoCompaction.mode` selects an independent automatic mode: `prune-summary`
(default, prune old tool results then summarize if still above threshold),
`history-reference` (reset older context with a history reference), or
`provider-native` (native compaction only, requiring model support). Modes never
fall back to one another; unresolved pressure stops the run. Changed context
remains persisted even if it is still above threshold. The deprecated
`autoCompaction.providerNative` boolean selects native-only mode when true and
no `mode` is set; explicit `mode` wins.

Manual `/compact` uses prune-and-summary by default. `/compact history-reference`
and `/compact provider-native` select independent operations without changing
the automatic mode. Programmatic `autoCompactionMode` selects the same modes;
`autoCompactionStrategies` overrides the mode, with `[]` disabling automation.

History-reference mode requires saved work notes.
The model can query capacity with `get_context_remaining`, save `context_notes`,
and request `new_context`. The host warns at 80% of the configured reset threshold;
the threshold remains the hard boundary. Missing or stale notes block reset.
See [Context and durable history](../concepts/context-and-history.md#history-reference-work-memory)
for the handoff, retrieval, and failure rules.

The following fragment configures instructions, compaction, delegation, retries,
tracing and a local MCP server. Merge it into an existing configuration with
`providers` and `models`. Create the referenced instructions and server module
before enabling them, and provide `MCP_ACCESS_TOKEN` in the launching environment.

```json
{
  "apps": {
    "maybecode": {
      "instructionsDirectory": "instructions/maybecode",
      "autoCompaction": {
        "mode": "prune-summary"
      },
      "subagents": {
        "roles": {
          "worker": { "tools": ["read", "shell", "edit", "write"], "delegateTo": ["worker"] }
        },
        "defaultRole": "worker",
        "limits": { "maxConcurrent": 2, "maxDepth": 3 }
      },
      "retry": {
        "maxAttempts": 3,
        "baseDelayMs": 500,
        "maxDelayMs": 8000,
        "jitterRatio": 0.2
      },
      "observability": {
        "enabled": true,
        "exporter": "file",
        "file": "traces/traces.jsonl",
        "samplingRatio": 1,
        "retentionDays": 60,
        "batch": {
          "maxQueueSize": 2048,
          "maxExportBatchSize": 512,
          "scheduledDelayMs": 5000
        }
      },
      "mcpServers": {
        "workspace": {
          "transport": "stdio",
          "command": "node",
          "args": ["tools/mcp-server.mjs"],
          "cwd": ".",
          "required": false,
          "env": { "ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}" },
          "requestTimeoutMs": 60000,
          "maxTotalTimeoutMs": 300000,
          "maxBufferSize": 10485760,
          "stderrMaxBytes": 16384
        }
      }
    }
  }
}
```

Set `retry` to `false` to disable automatic retries. Relative instruction
directories are resolved from the directory containing `config.json`.

### Observability

Observability is disabled when `observability` is absent, `false`, or has
`enabled: false`. An object enables the file exporter; `enabled` defaults to
`true`, `exporter` currently accepts only `file`, and `samplingRatio` defaults
to `1`. `file` is a base path: MaybeCode inserts the local `YYYY-MM-DD` before
its extension. Relative paths are resolved below the MaybeCode data directory;
the default files are
`~/.may/maybecode/traces/traces-YYYY-MM-DD.jsonl`.

`retentionDays` defaults to `60` local calendar days, including today. On the
first export of a new day, MaybeCode deletes only matching rotated files older
than that window. Batch defaults are the values shown above;
`maxExportBatchSize` cannot exceed `maxQueueSize`.

MaybeCode flushes the processor during workspace shutdown. Each daily JSONL
file is append-only. The files are fail-open operational telemetry rather than
Session or audit truth; see
[Observability and tracing](../guides/observability.md).

### MCP servers

MCP is disabled when `mcpServers` is absent or `false`. Each property name is
the server id used in model-facing tool names. Entries default to the `stdio`
transport, require `command`, and accept `args`, `cwd`, `env`, request timeout,
total timeout, message-buffer limits, and stderr-tail limits. Servers are
required by default, so connection or discovery failure aborts startup. Set
`required` to `false` to keep the application usable while recording that
server as failed. Set `enabled` to `false` to skip an entry without deleting
its configuration.

Set `transport: "streamable-http"` for HTTP endpoints. They require `url` and
accept `headers` (with `${NAME}` environment references), `auth`, `required`, request
and total timeouts, and `protocolMode`. Process options (`command`, `args`,
`cwd`, `env`, `maxBufferSize`, `stderrMaxBytes`) are rejected on HTTP entries.
`url`/`headers` are rejected on stdio entries. `protocolMode` accepts `legacy`
or `auto`, defaulting to legacy for stdio and auto for HTTP. HTTPS is required
except for loopback; redirects are not followed. Automatic reconnect is not yet
implemented. `auth: { "type": "oauth" }` enables native OAuth; optional fields
are `account`, `clientId` + `expectedIssuer`, `clientMetadataUrl`, `scopes`,
`authorizationOrigins`, and `callbackPort`. OAuth and a static Authorization
header are mutually exclusive. See [MCP authentication](../guides/mcp-auth.md)
for login/logout, credential storage and origin restrictions.

Relative `cwd` values and omitted `cwd` resolve to the active MaybeCode
workspace. Environment strings expand `${NAME}` from the launching process;
missing references fail startup. Prefer references because the configuration
file is plaintext. Discovered tools are namespaced, pass through MaybeCode's
normal permission and scheduling path, and use a fixed snapshot per Run. Explicit
refresh/reconnect and catalog notifications update later Runs. `/mcp` reports server state, negotiated protocol version, tools, errors, and the bounded
sanitized stderr tail. See [MCP tools](../guides/mcp.md).

Both transports accept `host: { roots: true, sampling: true, legacyRequests: "isolated" }`.
All three options require explicit enabling. Roots/Sampling also require an interaction
UI; headless use must enable and consume `mcpInteractions`. Legacy isolation creates
a fresh process/session per interactive tool, read or prompt operation; server session
state is local to that operation. See
[Host compatibility](../guides/mcp.md#roots-sampling-and-legacy-compatibility)
for consent, budgets and custom services. The editor schema covers HTTP, OAuth and
Host fields; runtime validation also checks endpoint and header safety.

Both transports accept `tasks: true` (default `false`), requiring protocol
2026-07-28 and the server Tasks extension. For stdio, set `protocolMode: "auto"`.
MaybeCode uses an encrypted journal at `<dataDirectory>/mcp-tasks`; custom pool
hosts inject `taskJournal`. Store failure prevents task creation. Host input still
requires its corresponding services and interaction UI. See
[long-running tasks](../guides/mcp-tasks.md) for controls and restart behavior.

## MaybeCode terminal interaction

MaybeCode's retained terminal frontend reads `MAY_TUI_LEADER` (default `ctrl+g`)
for display-action sequences. Choose one modified key that does not conflict
with editor shortcuts. `MAY_CLIPBOARD` accepts `auto`, `system`, `osc52`, or
`disabled`; local auto uses the system clipboard, while SSH requires explicit
OSC 52 configuration and terminal permission. These are frontend environment
settings and do not enter the agent's context. See
[terminal interaction](../guides/maybecode.md#browse-maybecode-conversations).

## MaybeClaw settings

`apps.maybeclaw` uses `version: 2`, an optional `agents` list (defaults to `[]` when
omitted), `access`, `server`, and `channels.telegram` / `channels.feishu`.
`server.maxConcurrent` defaults to 4. Missing MaybeClaw configuration or administrator
authentication opens local password initialization on service startup. Initialization
preserves existing settings and directly saves `passwordHash`, `version: 2`, and an
empty Agent list when absent. Existing old configurations require explicit migration.
For manual setup, users can configure only the administrator password,
`version: 2`, and `agents: []` (or omit `agents`) to start the Web console, add the first
Agent through the Web manager, and create sessions without restarting. Existing May
`providers` and `models` are retained for May Agents.
Each Agent configures its model, startup settings, permissions, and `runBudget`.

`apps.maybeclaw.persistentRules` defaults to `false`. Enabling it stores rules
in `<data-directory>/permission-rules.json` under one Gateway-owned writer lock.
May Agent rules bind the initiating identity, Agent and canonical project path.
Only service operators can choose persistent approval or create, list and revoke
rules in the Web manager. Channel users continue to receive ordinary approval
choices. Management events are saved in Gateway storage; execution and approval
events remain in Agent Session history. See
[Permission policies](../guides/permission-policy.md).

Channels default to disabled and require permitted users or groups when enabled.
Telegram accepts a literal `botToken` or
an environment-variable name in `botTokenEnv`; Feishu accepts `appSecret` or
`appSecretEnv`. Each pair is mutually exclusive. Omitting both uses the default
environment variable. Inline credentials are stored in plaintext: protect the
config file and never commit it. Changing channel settings requires restarting `serve`.
Gateway `serve` requires `server.auth.password` (10–1024 characters) or its
generated `passwordHash`. Startup and configuration saves convert the password
to salted Argon2id; changing it invalidates existing logins. `server.auth.sessionMs`
defaults to 28800000 and accepts 1000–86400000 milliseconds. Web login accepts the
original password. Remote CLI reads `MAYBECLAW_ADMIN_PASSWORD` or `--password-env`.
The editor schema shares the RunBudget definition across both products. See the
[MaybeClaw guide](../guides/maybeclaw.md) for Agent definitions, permissions,
chat entrances, authentication, and execution/recovery boundaries.

## Maintenance source of truth

The schema and this guide are user-facing references. When adding or changing a
built-in adapter option, update both alongside the runtime parsing in
`packages/providers/src/builtins.ts`.
