# MaybeCode

MaybeCode is the terminal coding-agent application assembled from May's Core,
session, permission, provider, configuration, and coding-tool packages.

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
complete package graph can be packed, installed without registry access, and
launched outside this repository with:

```sh
pnpm test:package:maybecode -- --directory /path/to/temporary-parent
```

The smoke test builds and packs MaybeCode plus all transitive May workspace
packages, installs only those tarballs into an isolated consumer project, and
verifies both `maybecode --help` and an interactive start/quit cycle.

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

OpenAI compaction is opt-in. `serverCompactThreshold` enables provider-side
context management on normal Responses requests, while
`apps.maybecode.autoCompaction.providerNative` lets MaybeCode call the model's
native compactor as an automatic fallback:

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
        "providerNative": true
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

In an interactive terminal, suggestions are shown as the first input line is
edited. For example, `/re` shows `/resume` and `/retry`; `/compact ` filters
compaction strategies; `/resume ` filters known session IDs; and `/model `
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
- `/compact` prunes eligible old tool results and persists the active view.
- `/compact summary-tail` summarizes older turns and retains the recent tail.
- `/compact history-reference` keeps the current turn and points the model to
  the bounded `session_history` tool for older details.
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

`/compact` uses `prune-old-tool-results`: it keeps the four newest
tool results and replaces older results of at least 2 KiB with short
placeholders. The original session events remain in JSONL, while subsequent
model requests and resumed sessions use the compacted view.

`/compact summary-tail` makes a separate, tool-free request to the active model
to summarize all but the two most recent user turns. It only applies a
non-empty summary that reduces serialized context size. The summary request can
be cancelled with `Ctrl+C`; a cancelled or failed summary is not persisted.
Programmatic callers can inject `contextSummarizer` or pass their own
`ContextCompactionStrategy`.

Before each model request, MaybeCode automatically checks context pressure
when the model has a configured context-window limit. By default, the trigger
ratio is 90%, bounded by the window after the configured output reserve. It
first tries `prune-old-tool-results`, then `summary-tail`, and finally
`history-reference`. Provider-native automatic compaction is disabled by
default. When `apps.maybecode.autoCompaction.providerNative` is `true` and the
model exposes that capability, it is inserted after prune and before
`summary-tail`; it is never the first strategy. Each changed view is persisted as `context.compacted`
before the model request and is restored on session resume. The terminal
reports automatic compactions. Programmatic callers can replace the ordered
chain with `autoCompactionStrategies`, pass `providerNativeAutoCompaction`, or
pass an empty strategy array to disable automatic compaction.

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
