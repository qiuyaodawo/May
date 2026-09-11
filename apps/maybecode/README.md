# MaybeCode

MaybeCode is the terminal coding-agent application assembled from May's Core,
application, session, permission, provider, configuration, coding-tool, and TUI
packages.

## Component boundary

MaybeCode is a product composition layer. Generic lifecycle does not live in
the app:

- `@may/core`'s instance-scoped `ToolRegistry` composes the coding tools;
- `@may/application`'s `defineAgent()` captures reusable behavior, while its
  application/workspace layer owns run/retry/cancel, approval relaying,
  Session history, Context compaction persistence, closing, session switching,
  and Catalog summaries;
- `@may/tui/transcript` projects live and restored Agent events, and
  `@may/tui/tool-renderers` supplies an instance-scoped renderer registry;
- `@may/coding-tools/instructions` loads bounded, path-safe instruction files;
- the generic list-selection and Slash-command state models also live in
  `@may/tui`.

The app retains the decisions that define the MaybeCode product: its prompt and
instruction composition, default coding tools and permission policy, coding
change previews, model profiles and reasoning effort, compaction strategy
order, concrete commands, product event compatibility, terminal layout, theme,
and picker workflows. This separation makes the extracted components reusable;
it does not make MaybeCode or the `0.1.0` APIs production-stable.

## Noninteractive multi-agent teams

`maybecode team run "Inspect this module" --workspace <path>` runs two
independent read-only workers and a supervisor with isolated workspace copies,
shared model-call/token limits, durable task state, and immutable output
artifacts. It reuses configured model profiles but never enables Shell, MCP, or
source writes. `team status <id>`, `team resume <id>`, and `team cancel <id>`
provide terminal lifecycle controls. See the [English guide](../../docs/en/guides/maybecode-team.md)
or [简体中文指南](../../docs/zh-CN/guides/maybecode-team.md) for bounds, storage,
cancellation and recovery semantics.

## Custom UIs

`MaybeCodeController` is the headless UI boundary. A custom terminal, desktop,
or remote UI sends user actions through its methods and renders its
`AsyncIterable<MaybeCodeEvent>` stream:

```ts
import {
  openConfiguredMaybeCode,
  type MaybeCodeController,
} from "@may/maybecode";

const controller: MaybeCodeController = await openConfiguredMaybeCode();

const observation = (async () => {
  for await (const event of controller.events) {
    render(event);
  }
})();

await (await controller.submit({ input: "Inspect this workspace." })).result;
await controller.close();
await observation;
```

The controller covers submission, cancellation, approvals, sessions, history,
session rename/deletion, and context inspection/compaction.
`MaybeCodeWorkspace` is the default concrete
implementation. `MaybeCodeTerminal` is only the low-level input/output adapter
for the bundled `runTerminalUI`; implementing it changes terminal mechanics but
does not replace the bundled UI's command or rendering policy.

Custom UIs can reuse the bundled command policy without reusing the terminal
renderer. `MAYBECODE_SLASH_COMMANDS` exposes command metadata,
`createMaybeCodeSlashCommandSuggester(controller)` provides command, compaction
strategy, and session suggestions, and
`executeMaybeCodeSlashCommand(input, controller)` returns a structured result
for the UI to render. Alternatively, a UI can call `MaybeCodeController`
directly and define a completely different command system.

The bundled SessionPicker uses the optional `@may/keybindings` package to map
context-specific key sequences to semantic actions. Custom UIs may reuse that
resolver or provide their own keyboard and interaction system.

The retained-screen frontend is the default. The previous line-oriented
frontend remains available with `maybecode --ui classic [workspace]`. The
retained frontend supports Slash-command completion and a `/resume` dialog with search (`/`),
rename (`r`), delete (`d`), and resume (`Enter`) actions. It also renders safe
terminal Markdown and uses specialized, collapsible renderers for `read`,
`shell`, `edit`, and `write`.

Retained-view display shortcuts use the existing leader key (`Ctrl+X`):

- `Ctrl+X`, then `D` toggles tool output and unified diff details.
- `Ctrl+X`, then `T` toggles reasoning-block visibility.

The same display actions are available as TUI-local `/details` and `/thinking`
commands. They are handled by the retained frontend and do not enter the agent
controller or session history.

Press `Tab` to focus the transcript. In transcript focus, `J`/`K` selects the
next/previous tool, `Enter` or `Space` toggles only that tool, and arrow or page
keys scroll. Expanding a historical tool detaches from end-following so its
header stays in view; submitting a new prompt resumes following the live run.

## Run

Configure a built-in provider in `~/.may/config.json`, then run:

```sh
pnpm maybecode
pnpm maybecode /path/to/workspace
pnpm maybecode --continue /path/to/workspace
pnpm maybecode --resume <id> /path/to/workspace
```

A normal launch always starts a new session. Use `--continue` to resume the
most recent session for the workspace, or `--resume <id>` to select a specific
session. Starting a new session does not delete or overwrite older sessions;
they remain available through `/resume`.

The private package exposes a `maybecode` executable for local packaging. Its
complete package graph can be packed, installed in a fresh consumer project, and
launched outside this repository with:

```sh
pnpm test:package:maybecode -- --directory /path/to/temporary-parent
```

The smoke test builds and packs MaybeCode plus all transitive May workspace
packages, installs those local tarballs into an isolated consumer project, and
verifies both `maybecode --help` and an interactive start/quit cycle. External
dependencies reuse the pnpm store when available; missing versions are downloaded
from the registry because the consumer resolves its own dependency graph.

In Git Bash on Windows, use forward slashes or quote backslash paths. An
unquoted `E:\code\project` is changed by Bash before MaybeCode receives it:

```sh
pnpm maybecode E:/code/project
pnpm maybecode /e/code/project
pnpm maybecode 'E:\code\project'
```

MaybeCode creates configured models through `@may/providers`. Provider names
identify configured connections; adapters identify protocols. Its built-in
adapter registry supports `deepseek-chat`, `zhipu-chat`, `kimi-chat`,
`anthropic-messages`, `openai-responses`, and `openai-chat-completions`.

Optional model limits let MaybeCode report context-window usage:

```json
{
  "providers": {
    "deepseek": {
      "adapter": "deepseek-chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "baseURL": "https://api.deepseek.com"
    }
  },
  "models": {
    "deepseek-chat": {
      "provider": "deepseek",
      "model": "deepseek-chat",
      "contextWindowTokens": 64000,
      "maxOutputTokens": 8192
    }
  },
  "defaultModel": "deepseek-chat"
}
```

MaybeCode retries transient model requests up to three total attempts by
default. Retries apply to one model request rather than the whole agent run, so
tools completed in earlier steps are not replayed. Configure the backoff under
`apps.maybecode.retry`, or set it to `false` to disable automatic retries:

```json
{
  "apps": {
    "maybecode": {
      "retry": {
        "maxAttempts": 3,
        "baseDelayMs": 500,
        "maxDelayMs": 8000,
        "jitterRatio": 0.2
      }
    }
  }
}
```

HTTP 408, 409, 429, server failures, common network failures, and provider
overload events are retried. Authentication, request-validation, protocol, and
cancellation failures are not. Provider `Retry-After` hints are respected up
to `maxDelayMs`.

MaybeCode tracing is disabled when `apps.maybecode.observability` is absent or
`false`. Configure an object to write content-free completed spans to JSONL:

```json
{
  "apps": {
    "maybecode": {
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
      }
    }
  }
}
```

`file` is a base path. MaybeCode inserts the local `YYYY-MM-DD` before its
extension and writes one file per calendar day. Relative paths use the
MaybeCode data directory, so the default output is
`~/.may/maybecode/traces/traces-YYYY-MM-DD.jsonl`. On the first export of each
day, files from calendar dates outside the latest 60 days are removed;
`retentionDays` can override that positive-day limit. Unrelated files and the
current 60-day window are left untouched.

MaybeCode flushes and shuts down the batch processor after its workspace
closes. The preview span schema is not an audit contract. Trace files contain
operational ids, tool/model names, counts, timings, statuses, usage, and
decisions, but no prompts, reasoning, or tool input/output from built-in
instrumentation.

MaybeCode can also add tools from local MCP stdio or remote Streamable HTTP servers:

```json
{
  "apps": {
    "maybecode": {
      "mcpServers": {
        "workspace": {
          "command": "node",
          "args": ["tools/mcp-server.mjs"],
          "cwd": ".",
          "required": false,
          "env": { "ACCESS_TOKEN": "${MCP_ACCESS_TOKEN}" }
        },
        "remote": {
          "transport": "streamable-http",
          "url": "https://mcp.example.com/mcp",
          "headers": { "Authorization": "Bearer ${MCP_REMOTE_TOKEN}" },
          "required": false
        }
      }
    }
  }
}
```

Discovered tools are exposed as `mcp__workspace__<tool>`, composed with the
built-in coding tools, and require approval under the default policy. Relative
working directories use the active workspace. Environment references in `env` and HTTP `headers` must
exist when MaybeCode starts. The client pool and its child processes close with
the workspace; with tracing enabled, disconnect spans are flushed afterward.
See the bilingual [MCP guide](../../docs/en/guides/mcp.md) for timeout options,
security, protocol negotiation, and remaining limitations. HTTP uses automatic
modern/legacy negotiation by default; stdio keeps the legacy handshake unless
`protocolMode: "auto"` is requested. HTTPS is required except for loopback;
redirects and automatic tool-call retries are disabled. Static headers are
supported; native OAuth login/refresh/logout is available through `maybecode mcp login`,
`status`, and `logout`. See [MCP authentication](../../docs/en/guides/mcp-auth.md)
for OS-keyring-backed storage, origin allowlists, and public client registration.

Use `/mcp` to inspect every configured server, its required/optional state,
negotiated protocol version, discovered tools, connection diagnostics, and bounded stdio stderr.
MCP lifecycle events are also forwarded through `MaybeCodeController.events`.

OpenAI compaction is opt-in. `serverCompactThreshold` enables provider-side
context management on normal Responses requests, while
`apps.maybecode.autoCompaction.mode: "provider-native"` selects the model's
native compactor as an independent automatic mode:

```json
{
  "providers": {
    "openai": {
      "adapter": "openai-responses",
      "apiKeyEnv": "OPENAI_API_KEY",
      "options": {
        "reasoningEffort": "high",
        "reasoningSummary": "auto",
        "serverCompactThreshold": 100000
      }
    }
  },
  "models": {
    "gpt": {
      "provider": "openai",
      "model": "gpt-5.4",
      "contextWindowTokens": 128000,
      "maxOutputTokens": 8192
    }
  },
  "defaultModel": "gpt",
  "apps": {
    "maybecode": {
      "autoCompaction": {
        "mode": "provider-native"
      }
    }
  }
}
```

## Instructions

MaybeCode uses its built-in system prompt unless `apps.maybecode` configures an
instruction directory:

```json
{
  "apps": {
    "maybecode": {
      "instructionsDirectory": "instructions/maybecode"
    }
  }
}
```

Relative paths are resolved from the directory containing `config.json`; `~`
resolves to the user home directory. The configured directory must contain a
non-empty UTF-8 `system.md`. It completely replaces the built-in system prompt.
An optional `AGENTS.md` at the workspace root is then appended as project
instructions. Each file has a 32 KiB limit.

MaybeCode also appends a short generated runtime section describing the actual
shell used by the `shell` tool. This operational metadata is independent of
`system.md`, so a custom system prompt cannot accidentally tell the model to use
Bash syntax when the tool is running PowerShell, or vice versa.

Use `/instructions` to inspect the active sources and effective instructions.

Programmatic callers can pass a `ContextFactory` to
`openConfiguredMaybeCode`, `MaybeCodeWorkspace.open`, or
`MaybeCodeApplication.open`. When omitted, MaybeCode uses
`InMemoryContextFactory` from `@may/context`. Factories return the Core context
and may also return a `ContextController` for application-level inspection.

## Commands

MaybeCode discovers Agent Skills and loads instructions/resources on demand.
`/skills` lists them, `/skills show <name>` previews them, and
`/skills use <name> [task]` activates and optionally submits a task. Both UIs
support name completion. Activation survives compaction/resume and never grants
script permissions. See [Agent Skills](../../docs/en/guides/skills.md).

Set `apps.maybecode.runBudget` to bound each Run's duration, steps, model/tool
calls, observed tokens and estimated cost. See [Run budgets](../../docs/en/guides/run-budgets.md).

Interrupted tools with unknown outcomes block further runs. `/recovery` lists
their original input; `/recovery resolve <id> <verified finding>` records the
result of checking external effects. No tool is replayed by recovery. See
[Crash recovery](../../docs/en/guides/recovery.md).

In an interactive terminal, suggestions are shown as the first input line is
edited. For example, `/re` shows `/resume` and `/retry`; `/compact ` offers
`history-reference` and `provider-native`; `/resume ` filters known session IDs;
and `/model `
filters configured model-profile names. `/effort ` filters the active model's
discovered reasoning levels. Suggestions also participate in input:
`Enter` executes the first displayed candidate,
while `Tab` completes the longest unambiguous prefix without executing it. A
single candidate is completed in full. For example, candidates `/commanda` and
`/commandb` complete `/comm` to `/command`. Approval prompts and multiline
continuation lines do not show command suggestions.

- `/new` creates a session.
- `/resume` opens the interactive session picker; `/resume <id>` switches
  directly without opening it.
- `/model` opens the configured model-profile picker. `/model <prefix>` switches
  to the first profile whose name starts with the prefix, in configuration
  order. Switching rebuilds the model runtime while preserving the active
  session and its durable context. `/model <prefix> --default` also persists
  the selected profile as the configuration's `defaultModel`.
- `/effort` opens the active model's reasoning-effort picker. `/effort <prefix>`
  selects the first matching supported level, while `/effort default` clears
  the runtime override. Changing effort rebuilds the model runtime but keeps the
  active session and durable context. When reliable capability metadata is not
  available, MaybeCode reports the capability as unknown instead of guessing.
- `/retry` continues the latest failed run without adding another user message
  or replaying already completed tools.
- `/instructions` shows active instruction sources and content.
- `/status` shows the active provider/model, session, workspace, and compact
  context usage.
- `/context` shows message counts, size, measured usage, and window remaining.
- `/compact` prunes eligible old tool results, summarizes older turns, and
  retains the recent tail.
- `/compact history-reference` keeps the current request and fresh saved work
  notes; older details remain available through history tools.
- `/mcp` shows configured MCP server states, discovered tools, errors, and
  retained stderr diagnostics.
- `/help` shows commands.
- `/quit` exits.
- `Ctrl+C` cancels an active run or summary and exits while idle.

The `/resume` picker has its own shortcut context:

- `Up`/`Down`, `PageUp`/`PageDown`, and `Home`/`End` move the selection.
- `Enter` resumes the selected session without automatically prompting the
  model.
- `/` enters search mode. It matches the current workspace's session ID,
  title, and latest message preview with a case-insensitive substring search;
  it does not scan the complete JSONL history. `Enter` finishes and `Esc`
  closes search mode and clears the filter.
- `Space` toggles metadata and message preview.
- `R` renames the selected session.
- `D` opens a deletion confirmation; `Y` deletes and `N` or `Esc` cancels.
- `Esc` closes the picker and `Ctrl+C` is an emergency close.

The active session cannot be deleted. Deleting another session removes both
its workspace-catalog entry and its durable JSONL history.

The `/model` and retained `/effort` pickers use the same list navigation keys (`Up`/`Down`,
`PageUp`/`PageDown`, `Home`/`End`, `Enter`, and `Esc`). At the command line,
`Tab` only completes: one candidate completes fully, multiple candidates
complete their longest common prefix, and no additional common prefix leaves
the input unchanged.

The `/model` picker marks the active and default profiles separately. Press
`D` to make the selected profile the default without switching the active
model; the picker remains open with the updated marker. In the non-screen
fallback picker, enter `d <number-or-name>`. The change is atomically written
to the configuration file that was actually loaded, including a custom
`--config` path, and applies to future launches that omit `--model`.

The retained editor keeps submitted prompts and commands in bounded in-process
history. At the first or last logical line, `Up`/`Down` navigates that history;
inside multiline input it moves between lines. `Ctrl+W`, `Ctrl+Backspace`, or
`Alt+Backspace` deletes the previous word, and modified Left/Right moves by
word. `Shift+Enter` inserts a newline when the terminal reports that modifier.
Bracketed multiline paste is inserted as text and cannot accidentally execute
embedded lines one at a time.

The retained header displays the effective effort beside the active model name
and refreshes it after `/model` or `/effort`. Unknown capability metadata is
shown explicitly as `effort: unknown`.

End an input line with a single backslash to continue composing on the next
line. Interactive input is kept in an in-process history, while approval
answers are excluded. Asynchronous session, model, tool, and approval output
temporarily clears and then redraws the active prompt so partially typed input
is preserved. Input history is not persisted to disk.

Before the first model response, `/context` uses a provider-independent
`UTF-8 bytes / 4` estimate. When the provider reports input usage, it combines
that measured request prefix with an estimate for messages added afterward.
This is intended for context pressure management, not exact billing. It also
shows the input budget and compaction threshold. A custom context without a
controller reports that inspection is unsupported.

`/compact` first keeps the four newest tool results and replaces older results
of at least 2 KiB with short placeholders. It then makes a separate, tool-free
request to the active model to summarize all but the two most recent user
turns. Both phases are applied atomically as `prune+summary-tail`; a cancelled
or failed summary is not persisted. The original session events remain in
JSONL, while subsequent model requests and resumed sessions use the compacted
view. Programmatic callers can inject `contextSummarizer` or replace the
default with their own `ContextCompactionStrategy`.

`/compact history-reference` is the explicit stronger alternative: it requires
fresh `context_notes` and retains the latest user request, saved notes, and host
instructions, rather than the current turn's entire tool transcript. Original
events remain in Session history. It can therefore release space within one
long user task. Without valid, fresh notes or enough space for the replacement,
it fails without removing the existing view.

`/compact provider-native` invokes only the active model's native compactor,
without pruning or summarization. Unsupported models report an error. Manual
commands do not change the configured automatic mode; `/compact` continues to
use prune-and-summary by default.

Before each model request, MaybeCode automatically checks context pressure
when the model has a configured context-window limit. By default, the trigger
ratio is 90%, bounded by the window after the configured output reserve. It
uses `apps.maybecode.autoCompaction.mode` to select one independent mode:

- `prune-summary` (default): try `prune-old-tool-results`, then `summary-tail`
  only if pressure remains. It never automatically resets history or calls a
  native compactor.
- `history-reference`: use work notes and history retrieval; no summary call.
  The model can request a reset with `new_context` before the threshold.
- `provider-native`: run only the model's native compactor; selecting this mode
  requires native support from the active model.

Modes do not fall back to one another. If the selected mode cannot reduce
context below the threshold, the run fails with a compaction exhaustion error.
Each changed view is persisted as `context.compacted` before the model request
and is restored on resume, including a summary that is still above threshold.
Programmatic callers select `autoCompactionMode`; an explicit
`autoCompactionStrategies` array overrides it, and an empty array disables
automatic compaction. The deprecated `providerNative: true` configuration and
`providerNativeAutoCompaction: true` option now select native-only mode when no
mode is specified; an explicit mode takes precedence.

### History-reference work memory

In `history-reference` automatic mode, the model receives guidance to manage
long tasks proactively. `get_context_remaining` reports approximate usage,
window capacity, and remaining space before reset when the model asks; it is
not a per-request usage broadcast. A system-message warning is inserted once
per window when usage reaches 80% of the configured compaction threshold.
The threshold itself remains the hard boundary (90% of the model window by
default, subject to reserves); a large response may skip the warning range.

`context_notes` reads or replaces one session-local work note, up to 12 KiB of
serialized UTF-8 JSON. A save requires nonempty `goal`, `constraints`, `progress`,
and `nextSteps`; optional `historyRefs` contains up to 20 existing event sequence
numbers. Notes are persisted as Session state and survive resume, model changes,
and compaction; a new Session has separate notes. This is not a general file
notebook. The host checks that notes postdate the previous history reset and
cover the latest user input, non-memory tool outcomes, and recovery changes.
These checks establish freshness, not the semantic accuracy of model-written notes.

The model saves notes in a single-tool step after other tools finish, then calls
`new_context` in another single-tool step. Reset happens at the next model
snapshot, after tool outcomes have been persisted. It retains other system
messages, the latest user request and the note, but removes old handoffs,
capacity reminders, assistant messages, and tool results. Missing, stale, or
oversized notes stop the reset; there is no summary/native fallback. The built-in
controller restores the old view if checkpoint persistence fails. Unresolved
tool recovery also blocks reset. A custom context must support deferred
compaction and rollback to use this mode. A notes write failure stops the Run;
repair storage and reopen the session before continuing.

`get_context_remaining` and `context_notes` are also available in other modes,
so notes can be prepared for manual `/compact history-reference`. Only automatic
history-reference mode exposes `new_context` and adds proactive guidance/warnings.
Explicit custom strategy arrays keep their existing caller-defined behavior.

The `read` tool runs without approval. `shell`, `edit`, and `write` require an
allow-once, allow-for-session, or deny decision. The shell tool is not a sandbox.
The read-only `session_history` tool also runs without approval and returns
bounded pages of durable events from only the active session.
Allow-for-session grants currently last for the running MaybeCode process and
are not restored after restart.

Before `edit` and `write` execute, MaybeCode shows a bounded unified diff. After
execution it reports the file, whether it was created or updated, and the
numbers of added and deleted lines. A preview is still shown when a previous
allow-for-session grant skips the approval prompt. Preview metadata is stored
as a versioned Session presentation event, so the same diff remains available
after `/resume`; older histories without this event continue to load normally.

Session event logs and the workspace catalog are stored under
`~/.may/maybecode`. They are plaintext and currently require a single active
writer per session.

## Tests

The regular suite is offline:

```sh
pnpm --filter @may/maybecode test
```

The opt-in DeepSeek test reads `~/.may/config.json`, performs a real tool call,
reopens the saved session, and sends a follow-up:

```sh
pnpm test:integration:maybecode
```

MCP tool catalogs now update at Run boundaries. `/mcp refresh [server-id]`
refetches metadata; `/mcp reconnect <server-id>` recovers a configured endpoint
without replaying tool calls (including after OAuth login). `/mcp` reports catalog
revision/staleness and notification coverage. `/mcp read`, `template`, `prompt`
and `complete` preview data; `attach` and `use-prompt` explicitly submit user-level
content; `watch`/`unwatch` manage notification-only subscriptions. See the bilingual
[MCP guide](../../docs/en/guides/mcp.md).

Both interactive terminal UIs support modern MCP form/URL elicitation, with
explicit review/send, decline/cancel, and manual URL navigation/resume. Answers
are not command history. Library hosts must opt in with `mcpInteractions: true`
and consume the controller interaction events; no UI means no advertised
elicitation. Unscoped legacy requests decline; `host.legacyRequests: "isolated"` enables
per-operation compatibility. `host.roots` and `host.sampling` enable reviewed root
sharing and isolated, bounded sampling (including remote tool proposals, never
execution of host tools). All three options default off.

Opt-in `tasks: true` adds modern long-running MCP jobs with a separate encrypted
`<dataDirectory>/mcp-tasks` journal. `/mcp tasks`, `task-get`, `task-wait`,
`task-update`, `task-retry-input`, `task-cancel` and `task-forget` are explicit
Session-bound controls; `task-attach` alone submits a completed result to a new Run.
Stopping local waiting is not remote cancellation. No automatic replay after
restart. See the bilingual [Tasks guide](../../docs/en/guides/mcp-tasks.md).

`/mcp apps` explicitly reports unsupported HTML in both terminal UIs. App-only
tools are hidden even without a graphical Host; model-visible text fallback remains.
Optional custom graphical integration: [Apps guide](../../docs/en/guides/mcp-apps.md).
