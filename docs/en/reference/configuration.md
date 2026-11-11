# May configuration reference

**English** | [简体中文](../../zh-CN/reference/configuration.md)

May reads `~/.may/config.json` by default. The configuration separates named
provider connections, selectable model profiles, and application settings.

Configuration loads, default-model updates, and MaybeClaw authentication updates
coordinate across local processes using `<config-path>.access` and
`<config-path>.access.gate`. First access creates these empty files and requires
directory write permission. Keep them beside
the configuration. Before serving configuration from a read-only directory,
call `loadMayConfig({ path })` once with directory write permission; later loads
only need read permission on the configuration and its access files. Upgrade all
processes that share a configuration together.

`createMayConfig(path, value, { signal? })` validates and creates a new configuration,
including missing parent directories. It uses exclusive file access and publishes
a synchronized temporary file through a hard link; the destination must be absent.
Existing files and symbolic links remain unchanged. Temporary files are removed
after success or failure. An aborted signal before publication leaves the target
absent; a completed publication remains saved. Storage must support hard links.
MaybeCode uses this operation during [first-run setup](../guides/maybecode.md#first-run-setup).

Use this page to look up fields and defaults. For application startup and controls,
see [MaybeCode](../guides/maybecode.md) or [MaybeClaw](../guides/maybeclaw.md).

[`packages/may/may-config.schema.json`](../../../packages/may/may-config.schema.json)
(exported as `@sortedyuan/may/config/schema`) describes `providers`, `models` and
`defaultModel`. Each application owns the schema of its `apps.<id>` entry and validates
it when it starts; an invalid value reports `MayConfigValidationError` with the field path.
For editor completion of a whole file, associate it with the composed schema of the
application that uses it:

| Application | Schema                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------ |
| MaybeCode   | `@sortedyuan/maybecode/config/schema` (`apps/maybecode/dist/maybecode-config.schema.json`) |
| MaybeClaw   | `apps/maybeclaw/dist/maybeclaw-config.schema.json`                                         |

For example, on this Windows checkout after `pnpm build` the user configuration can start with:

```json
{
  "$schema": "file:///E:/code/May/apps/maybecode/dist/maybecode-config.schema.json",
  "providers": {},
  "models": {}
}
```

The exact file URL depends on the checkout location. Editors also allow mapping
`~/.may/config.json` to the schema in workspace
settings without adding `$schema` to the file. Applications build their composed schema
with `createApplicationConfigSchema(id, section, title)` from `@sortedyuan/may/config` and
validate their entry with `createApplicationConfigValidator(id, section)`.

## Server search

Set `providers.<name>.options.webSearch` or `models.<name>.options.webSearch` to
an object to authorize server search. Omission leaves it disabled; `{}` enables
adapter defaults, except Zhipu requires `searchEngine`. A model value replaces
the entire provider value; `false` disables it.

| Adapter                   | `webSearch` fields                                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anthropic-messages`      | `version` (default `web_search_20250305`; also `web_search_20260209`, `web_search_20260318`), `maxUses`, `allowedDomains`, `blockedDomains`, `userLocation`, `allowedCallers`, `responseInclusion` |
| `openai-responses`        | `allowedDomains`, `blockedDomains`, `userLocation`, `searchContextSize`                                                                                                                            |
| `openai-chat-completions` | `userLocation`, `searchContextSize`; requires `gpt-5-search-api`                                                                                                                                   |
| `google-gemini`           | `timeRange: { startTime, endTime }`, `searchTypes: ["web", "image"]`                                                                                                                               |
| `zhipu-chat`              | required `searchEngine`, optional `count`, `domainFilter`, `recencyFilter`, `contentSize`, `searchPrompt`                                                                                          |

`userLocation` accepts nonempty `city`, `region`, `country`, and `timezone`
fields, with at least one present. `searchContextSize` accepts `low`, `medium`,
or `high`. Domain lists are mutually exclusive. Anthropic `responseInclusion`
accepts `full` or `none` and requires `version: "web_search_20260318"`;
`allowedCallers` accepts `direct` and `code_execution_20260120`. Newer search
versions can invoke server code execution. A client function named `web_search`
conflicts with Anthropic server search and raises `TypeError`.

Gemini requires both time endpoints in chronological order. Zhipu engines are
`search_std`, `search_pro`, `search_pro_sogou`, and `search_pro_quark`;
`recencyFilter` accepts `oneDay`, `oneWeek`, `oneMonth`, `oneYear`, or `noLimit`,
and `contentSize` accepts `medium` or `high`. Invalid combinations raise
`ProviderConfigurationError`. `deepseek-chat` and `kimi-chat` reject `webSearch`,
including `false`; use host search tools for those adapters.

Capability fields are `serverTools.webSearch`, `serverTools.webSearchWithFunctions`,
and `serverTools.alwaysSearches`. Request validation checks search and combined
function support using `unknownCapabilityPolicy`. Anthropic discovery reads
the provider's search capability. `gpt-5-search-api` always searches, including
when no search options are supplied.

## MaybeCode search and language servers

`apps.maybecode.webSearch: false` disables host search and overrides server search
for adapters accepting that option. Selecting an always-searching model then
fails. Otherwise, configure `webSearch.hostTool` with `backend` (`deepseek`,
`zhipu`, or `kimi-formula`) and `provider` (a key in `providers`). Zhipu also
requires `searchEngine`. Credentials and `baseURL` come from that provider;
missing providers or credentials fail configuration loading. `webSearch.maxResults`
defaults to 10, with a maximum of 50 for DeepSeek and Zhipu tools.

```json
{
  "apps": {
    "maybecode": {
      "webSearch": {
        "hostTool": { "backend": "deepseek", "provider": "deepseek" },
        "maxResults": 10
      },
      "lsp": {
        "servers": { "typescript": {}, "python": {} },
        "editDiagnostics": true,
        "diagnosticSeverities": ["error", "warning"],
        "startTimeoutMs": 60000,
        "requestTimeoutMs": 15000,
        "diagnosticsTimeoutMs": 3000
      }
    }
  }
}
```

At Run start, enabled server search takes precedence over the configured host
tool. Kimi Formula host tools are available only with `kimi-chat`. `/model`
reports search status. Host search uses tool approval and contributes usage.

Omitting `lsp` or setting it to `false` disables LSP. Listing servers authorizes
their processes to execute project programs. Presets are `typescript`, `python`,
`rust`, and `go`; servers start on demand. Each `servers.<id>` accepts `command`,
`args`, `languages` (languageId to extension array), `settings`,
`initializationOptions`, and `env`. Preset fields can be overridden. Custom ids
require `command` and `languages`; duplicate extensions fail loading.
`editDiagnostics` defaults to true. Additional manager limits are
`shutdownTimeoutMs: 5000`, `maxFileBytes: 1048576`, `maxResults: 200`,
`maxHoverChars: 8000`, `maxEditDiagnostics: 20`, `maxDiagnostics: 200`, and
`maxServers: 4`. See [LSP tools](../../../packages/tools/lsp/README.md) for inputs,
diagnostic status, rename recovery, and server installation.

The library execution option `cacheDirectory` provides writable server storage;
`cachePath` exposes its environment path, `/may-cache` in containers.
`toEnvironmentPath` and `toHostPath` translate workspace paths, and
`spawn(..., { stdin: "pipe" })` enables stdio protocol communication. MaybeCode
creates a workspace-specific cache under its data directory. Container images
must contain the configured servers and their runtimes; workspace npm servers
use the image's `node`. Container networking remains `none`. Prepare Go modules,
Cargo dependencies, and Rust sources in the workspace or image. Cache-based
`HOME`, `XDG_CACHE_HOME`, and `GOCACHE` accompany `GOFLAGS=-mod=readonly`,
`GOPROXY=off`, and `CARGO_NET_OFFLINE=true`.

## Top-level fields

| Field          | Required | Description                                                                                      |
| -------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `providers`    | yes      | Named connections containing an adapter, credentials, endpoint, and shared options.              |
| `models`       | no       | Named model profiles shown by model selectors such as MaybeCode `/model`.                        |
| `defaultModel` | no       | The model profile selected when no explicit model is supplied; MaybeCode `/model` can update it. |
| `apps`         | no       | Application-owned settings.                                                                      |

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

| Adapter                   | Options                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `openai-responses`        | `maxOutputTokens`, `reasoningEffort`, `reasoningSummary`, `serverCompactThreshold`, `store`, `responseFormat`, `webSearch` |
| `openai-chat-completions` | `maxOutputTokens`, `reasoningEffort`, `store`, `responseFormat`, `webSearch`                                               |
| `deepseek-chat`           | `thinking`, `reasoningEffort`, `maxTokens`                                                                                 |
| `zhipu-chat`              | `thinking`, `clearThinking`, `reasoningEffort`, `maxTokens`, `webSearch`                                                   |
| `kimi-chat`               | `thinking`, `reasoningEffort`, `maxTokens`                                                                                 |
| `anthropic-messages`      | `thinking`, `reasoningEffort`, `maxTokens`, `apiVersion`, `promptCaching`, `webSearch`                                     |
| `google-gemini`           | `maxOutputTokens`, `reasoningEffort`, `thinkingBudget`, `includeThoughts`, `responseFormat`, `webSearch`                   |

For `google-gemini`, `baseURL` includes the API version and defaults to
`https://generativelanguage.googleapis.com/v1beta`. A compatible gateway can use
`http://localhost:7861/antigravity/v1`. Requests use `x-goog-api-key` and append
`/models/{model}:streamGenerateContent?alt=sse`. `reasoningEffort` maps to
`thinkingConfig.thinkingLevel`; `thinkingBudget` accepts integers from `-1`
upward. Configure either effort or budget. `includeThoughts` is optional; omitted
thinking options use the server/model behavior. A provider that selects effort
through model names can use a name such as `gemini-3.8-flash-high` without an
additional effort option. See [Gemini adapter](../../../packages/providers/docs/gemini/README.md).

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
2. The provider's model endpoint, described below.
3. May's built-in model catalog, maintained from vendor documentation.
4. `unknown` when no reliable source describes the model.

Every built-in adapter queries its model endpoint at the configured `baseURL`,
or at the adapter's default service address when `baseURL` is unset:

| Adapter                                                                                   | Request                                   | Authentication                      |
| ----------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `openai-responses`, `openai-chat-completions`, `deepseek-chat`, `kimi-chat`, `zhipu-chat` | `GET {baseURL}/models?client_version=may` | `Authorization: Bearer`             |
| `anthropic-messages`                                                                      | `GET {baseURL}/v1/models?limit=1000`      | `x-api-key` and `anthropic-version` |
| `google-gemini`                                                                           | `GET {baseURL}/models/{model}`            | `x-goog-api-key`                    |

Model lists are matched as `models[]` entries by `slug` (CLIProxyAPI's Codex
catalog) or `data[]` entries by `id`. May reads reasoning efforts from the
matching entry's `supported_reasoning_levels`, `reasoning_levels`, or
`effort.supported_levels`, with the default from `default_reasoning_level` or
`effort.default_level`. A Gemini model with `thinking: false` reports reasoning
effort as unsupported. A `404` response or an entry without these fields leaves
the capability to the next source.

Many model endpoints only identify models. Capability
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

### Anthropic prompt caching

Anthropic `options.promptCaching` accepts `false` or an object such as
`{ "ttl": "5m", "cacheInstructions": true }`. `ttl` accepts `"5m"` (default) or
`"1h"`; `cacheInstructions` defaults to `false`. Provider `options` supply defaults;
model `options` replace the caching setting, including explicit `false` or `{}`.
The providers package defaults to disabled. MaybeCode defaults to
`{ "ttl": "5m", "cacheInstructions": true }` for the `anthropic-messages` adapter.
Provider or model settings override that application default.

Automatic caching marks the last cacheable block. `cacheInstructions` also marks
the last system block and last tool with the same TTL. There are four breakpoint
slots; automatic caching uses one. Conflicting TTLs on the last block produce HTTP 400.
Thinking history is preserved without adding explicit breakpoints to thinking blocks.

Five-minute writes cost 1.25x base input price, one-hour writes cost 2x, and reads
normally cost 0.1x. Minimum cacheable lengths depend on the model (for example,
Sonnet 4: 1,024 tokens; Opus 4.6: 4,096 tokens). Shorter prompts are processed
without caching. See the
[Anthropic caching reference](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
for current model thresholds and pricing exceptions. Compatible endpoints may
reject `cache_control`; set `options.promptCaching: false` for those endpoints.

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
must be outside the repository. Existing repositories are reused. Immediately before
the first approved workspace-changing tool, new projects receive a repository and
the request's existing files are checkpointed. Complete requests can create commits
using project ignore rules. Startup and read-only requests create no checkpoints.
Project directories and filesystem roots follow the same process.

`autoCommit: false` preserves Git observation and existing-version checkpoints
while leaving edits uncommitted. `readOnly: true` prevents Git initialization and
mutation and denies project-changing built-in tools. Headless hosts can require
commit approval through `git.authorizeCommit`. Tool approval mode is a separate
setting. See [Git workspaces](../guides/git-workspaces.md) for forks and restoration.

## MaybeCode delegation notifications

Automatic delegation status notices use `apps.maybecode.delegationNotifications`
(boolean, default `false`). `/delegations notifications on|off|status` changes or
queries the current process setting immediately, including during a run and
across Session switches. It does not write configuration. See
[sub-agent delegation](../guides/subagent-delegation.md#surfaces).

## MaybeCode permission mode

`apps.maybecode.permissionMode` accepts `"default"` (default) or `"yolo"`.
YOLO auto-approves tool requests while retaining explicit policy denials.
`--yolo` and `--no-yolo` override configuration; using both fails validation.
`/yolo` and `/yolo on` enable the mode, `/yolo off` disables it, and `/yolo status`
queries it. Pause or cancel active Runs, goals, and MCP operations before changing
the mode. The current workspace host retains the mode through Session and model
changes, including reasoning effort changes. Tool approvals continue to use the
current mode after these changes. Startup options determine it after a restart;
it is not saved in history or configuration. `/goal` uses the current mode.

Model and reasoning effort changes update plugins within the existing application
and Session. Pause or finish active work and resolve MCP interactions before
changing models. The update preserves conversation history, paused Goals, active
Skills and durable notes, refreshes model-dependent services and their event
subscriptions, and retains shared MCP connections. An update failure stops new
input until a model-update retry succeeds. You can retry the previous or requested
profile. Successful changes are recorded in Session history for historical forks.

The terminal and Web UI show **YOLO · Auto-approve**, with English notifications.
Web UI uses `UiSnapshot.badges`; classic terminals update the prompt through
`TerminalIO.updatePrompt` while preserving drafts and cursors. Tool validation,
cancellation, and records remain active. MCP user-input requests require answers.
Shell authority follows `apps.maybecode.execution`. Team authorization is configured separately.

`apps.maybecode.persistentRules` defaults to `false`. When enabled, `edit`,
`write`, and `fetch` grants use `.may/permission-rules.json` in the active project.
File approvals show the canonical path; network approvals use the URL origin.
Scope includes local user, project/worktree,
and main Agent; changing Session or model preserves matching rules. The host holds
the single-writer lock until shutdown. Rule and lock files are excluded from Git
checkpoints. `/permissions [list|allow <id>|deny <id>|revoke <id>]` and Web UI manage
existing ranges. Rules record an operator, and deny takes precedence.
`openConfiguredMaybeCode({ persistentRules })` overrides configuration. See
[Permission policies](../guides/permission-policy.md).

## MaybeCode execution and web access

`apps.maybecode.execution` defaults to `{ "mode": "host" }`. Container mode
requires all fields below. `network` accepts only `"none"`; `memoryBytes` must
be a positive safe integer and `cpuCount` a positive finite number. `image` must
be nonempty. Invalid fields raise `MayConfigValidationError` with field paths.

```json
{
  "apps": {
    "maybecode": {
      "execution": {
        "mode": "container",
        "image": "nixery.dev/shell/git/ripgrep/util-linux",
        "network": "none",
        "memoryBytes": 1073741824,
        "cpuCount": 2
      },
      "fetch": {
        "maxBytes": 1048576,
        "timeoutMs": 30000,
        "maxRedirects": 5
      }
    }
  }
}
```

Docker Desktop or a compatible running daemon is required. Pull the image before
startup; it must contain `bash`, `git`, `rg`, and `setsid`. Only the workspace is
mounted, at `/workspace`. The root is read-only, temporary storage is provided,
capabilities are removed, and privilege escalation is disabled. Unix uses the
host UID:GID; Windows uses `1000:1000`. Shell, search, delegated tools, and team
checks inherit execution configuration. File tools access the shared workspace
on the host; application close waits for cleanup. MCP servers remain on the host.

`apps.maybecode.fetch` is optional; the tool remains available when omitted.
`maxBytes` defaults to 1,048,576 and `timeoutMs` to 30,000, both positive safe
integers. `maxRedirects` defaults to 5 and accepts a non-negative safe integer.
`allowedOrigins` is an optional array of HTTP/HTTPS origins such as
`["http://127.0.0.1:8080"]`; only listed origins are allowed, including local
addresses explicitly listed by the host. Without it, private, loopback, link-local,
and reserved addresses are rejected. Each redirect is checked independently and
connections use the checked DNS address. Requests send no host credentials or
cookies. HTML becomes readable text; text and JSON retain their content. Other
types fail. Byte limits truncate output; timeout and cancellation abort requests.
Network approvals are separate from file and shell approvals. YOLO uses existing
automatic approval rules, including persistent denials.

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
remains persisted even if it is still above threshold.

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
