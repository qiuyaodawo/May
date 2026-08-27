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

MaybeCode currently creates configured models for DeepSeek. The lower-level
provider adapters remain independently usable.

## Commands

- `/new` creates a session.
- `/sessions` lists sessions for the current workspace.
- `/resume <id>` switches sessions.
- `/help` shows commands.
- `/quit` exits.
- `Ctrl+C` cancels an active run and exits while idle.

The `read` tool runs without approval. `bash`, `edit`, and `write` require an
allow-once, allow-for-session, or deny decision. Bash is not a sandbox.
Allow-for-session grants currently last for the running MaybeCode process and
are not restored after restart.

Session event logs and the workspace catalog are stored under
`~/.may/maybe-code`. They are plaintext and currently require a single active
writer per session.

## Tests

The regular suite is offline:

```sh
pnpm --filter @may/maybe-code test
```

The opt-in DeepSeek test reads `~/.may/config.json`, performs a real tool call,
reopens the saved session, and sends a follow-up:

```sh
pnpm test:integration:maybe-code
```
