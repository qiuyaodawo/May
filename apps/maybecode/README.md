# MaybeCode

MaybeCode is the terminal coding-agent application assembled from May's Core,
session, permission, provider, configuration, and coding-tool packages.

## Run

Configure a built-in provider in `~/.may/config.json`, then run:

```sh
pnpm maybecode
pnpm maybecode /path/to/workspace
pnpm maybecode --new /path/to/workspace
pnpm maybecode --session <id> /path/to/workspace
```

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

MaybeCode creates configured models through `@may/providers`. Its built-in
registry supports DeepSeek, Zhipu GLM (`zhipu` or `glm`), Kimi, Anthropic, and
OpenAI Responses. The lower-level provider adapters remain independently
usable.

Optional model limits let MaybeCode report context-window usage:

```json
{
  "providers": {
    "deepseek": {
      "apiKeyEnv": "DEEPSEEK_API_KEY",
      "model": "deepseek-chat",
      "contextWindowTokens": 64000,
      "maxOutputTokens": 8192
    }
  }
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
      "apiKeyEnv": "OPENAI_API_KEY",
      "model": "gpt-5.4",
      "contextWindowTokens": 128000,
      "maxOutputTokens": 8192,
      "reasoningEffort": "high",
      "reasoningSummary": "auto",
      "serverCompactThreshold": 100000
    }
  },
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

Use `/instructions` to inspect the active sources and effective instructions.

Programmatic callers can pass a `ContextFactory` to
`openConfiguredMaybeCode`, `MaybeCodeWorkspace.open`, or
`MaybeCodeApplication.open`. When omitted, MaybeCode uses
`InMemoryContextFactory` from `@may/context`. Factories return the Core context
and may also return a `ContextController` for application-level inspection.

## Commands

- `/new` creates a session.
- `/sessions` lists sessions for the current workspace.
- `/resume <id>` switches sessions.
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

The `read` tool runs without approval. `bash`, `edit`, and `write` require an
allow-once, allow-for-session, or deny decision. Bash is not a sandbox.
The read-only `session_history` tool also runs without approval and returns
bounded pages of durable events from only the active session.
Allow-for-session grants currently last for the running MaybeCode process and
are not restored after restart.

Before `edit` and `write` execute, MaybeCode shows a bounded unified diff. After
execution it reports the file, whether it was created or updated, and the
numbers of added and deleted lines. A preview is still shown when a previous
allow-for-session grant skips the approval prompt.

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
