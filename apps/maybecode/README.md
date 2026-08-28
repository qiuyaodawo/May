# MaybeCode

MaybeCode is the terminal coding-agent application assembled from May's Core,
session, permission, provider, configuration, and coding-tool packages.

## Run

Configure DeepSeek in `~/.may/config.json`, then run:

```sh
pnpm maybecode
pnpm maybecode /path/to/workspace
pnpm maybecode --new /path/to/workspace
pnpm maybecode --session <id> /path/to/workspace
```

In Git Bash on Windows, use forward slashes or quote backslash paths. An
unquoted `E:\code\project` is changed by Bash before MaybeCode receives it:

```sh
pnpm maybecode E:/code/project
pnpm maybecode /e/code/project
pnpm maybecode 'E:\code\project'
```

MaybeCode currently creates configured models for DeepSeek. The lower-level
provider adapters remain independently usable.

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

## Commands

- `/new` creates a session.
- `/sessions` lists sessions for the current workspace.
- `/resume <id>` switches sessions.
- `/instructions` shows active instruction sources and content.
- `/help` shows commands.
- `/quit` exits.
- `Ctrl+C` cancels an active run and exits while idle.

The `read` tool runs without approval. `bash`, `edit`, and `write` require an
allow-once, allow-for-session, or deny decision. Bash is not a sandbox.
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
