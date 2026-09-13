# MaybeClaw: local durable tasks

**English** | [简体中文](../../zh-CN/guides/maybeclaw.md)

MaybeClaw is a second application built on May, alongside MaybeCode. It implements
bounded, persistent local tasks through CLI, Web UI, Feishu and Telegram. It is a single-user,
trusted-local-host product; the data directory is not a multi-tenant boundary.
No new shared task framework has been extracted yet.

## Start and submit

Configure a provider and model profile in the normal May configuration, then run
these commands from the repository. The root script builds the workspace first.

```powershell
pnpm maybeclaw --help
pnpm maybeclaw task submit "Summarize notes.txt and cite the evidence." --request-id notes-1 --read-directory C:\work\notes
```

`submit` first persists the task and prints its full 64-character ID. By default
it then runs in the foreground and prints the final task snapshot. Ctrl+C or
SIGTERM requests cancellation. Exiting this process is not detached/background
execution. Use `serve` below for a separate long-running queue consumer.

For an explicitly queued task:

```powershell
pnpm maybeclaw task submit "Explain these requirements." --request-id requirements-1 --enqueue
pnpm maybeclaw task list
pnpm maybeclaw task run <id>
pnpm maybeclaw task status <id>
pnpm maybeclaw task result <id>
```

Replace `<id>` with the full printed ID. `--enqueue` loads and validates model
configuration but does not construct/invoke a model. `task run` starts only a
provably unsubmitted queued task. Terminal tasks return their stored snapshot.
Only one process can own a given task at a time; different tasks may run in
different processes. Server concurrency does not constrain standalone foreground
CLI processes; there is no global daily quota service yet.

`--request-id` is optional; omission generates a UUID. Reuse a known key when
repeating a submission after a lost response. Its scope is the whole data
directory. The same key and specification return the existing task without
starting it again, including when it remains queued. Changed input, read scope,
model binding or budget with the same key is rejected. Simultaneous creation may
return a lock error; retry with the same key, not a new one. A generated key whose
response was lost can be found through `task list` and `task status`.

## Server and Web UI

Use PowerShell 7 to generate an operator token, then keep the server process running:

```powershell
$env:MAYBECLAW_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
pnpm maybeclaw serve --port 3939
```

Open `http://127.0.0.1:3939` and paste that environment variable's value into the
login form. You can copy it locally with `$env:MAYBECLAW_CONTROL_TOKEN | Set-Clipboard`;
clear your clipboard afterwards. Never put the token in a URL, repository or chat.
The server does not print it. `--token-env <name>` selects a different environment
variable; the token must contain 32..256 printable non-space ASCII characters.
Use a random value, not a memorable password.

The Web UI provides task submission, polling status, complete text results,
cancellation, evidence reconciliation, failed-dispatch retry, channel state and
the most recent 100 delivery records. Each submission is an independent task,
not a turn in a shared conversation. No streaming-token renderer is implemented.
Tokens live only in page memory: reload requires logging in again. All model
output is plain text, not executable HTML or rendered Markdown.

The server listens **only on 127.0.0.1**, requires bearer authentication for every
API request, checks Host/Origin, and sends a restrictive CSP. The operator token
grants access to **all** tasks; it is not a per-chat-user credential. Do not expose
this server through a tunnel/reverse proxy or use it as a multi-tenant service.

`serve` accepts the same `--config`, `--model`, `--read-directory` and
`--data-directory` host options. New Web/channel tasks receive only this host-selected
model and read scope; clients cannot supply paths, tools or budgets. A read scope
is also a grant to **every allowlisted channel user**. Only allow trusted users.
Previously queued standalone tasks retain their own explicitly authorized specs.

The host consumes queued tasks in creation order, with `server.maxConcurrent`
defaulting to 1 (range 1..4). At most 100 tasks may be waiting at server admission.
Closing a browser or CLI client does not cancel work. Closing the server with
Ctrl+C/SIGTERM stops receivers, requests cancellation of active runs and flushes
journals; not-yet-dispatched tasks remain queued for the next start. This is a
long-running process, **not an installed Windows/systemd service** or a scheduler.
Configure an OS supervisor separately if you need automatic startup.

Dispatch configuration errors remain queued and are shown in the Web UI; fix the
configuration, then use “retry dispatch”. This never authorizes replay of a
previously submitted input. An inbox processing error is retained with its stable
event ID, reported in health, and retried only after restarting the host.

One `host.lock` owns the channel journal and queue process. Task locks remain
separate. After an unclean shutdown, inspect the lock's PID/hostname and prove
the old owner stopped before manually removing that exact stale lock. Never
automatically steal a lock or erase execution evidence to start again.

## Chat channels

Merge this fragment into your normal May configuration; keep your existing
providers/models. Replace the sample app/user IDs. Both channels are disabled
unless `enabled: true`; enabled channels require a nonempty `allowUsers` list.

```json
{
  "apps": {
    "maybeclaw": {
      "server": { "maxConcurrent": 1 },
      "channels": {
        "telegram": {
          "enabled": true,
          "botTokenEnv": "MAYBECLAW_TELEGRAM_TOKEN",
          "allowUsers": ["123456789"]
        },
        "feishu": {
          "enabled": true,
          "appId": "cli_0123456789abcdef",
          "appSecretEnv": "MAYBECLAW_FEISHU_SECRET",
          "allowUsers": ["ou_replace_with_your_open_id"]
        }
      }
    }
  }
}
```

For direct configuration, replace `botTokenEnv` with `botToken` and/or
`appSecretEnv` with `appSecret`, using the actual credential as the value. For example,
the Telegram object can be:

```json
{
  "enabled": true,
  "botToken": "123456789:REPLACE_WITH_YOUR_REAL_BOT_TOKEN",
  "allowUsers": ["123456789"]
}
```

Each literal/environment-name pair is mutually exclusive. Never put a token in
`botTokenEnv`: that field is a variable name, not a credential value. Omitting both
fields uses the default environment variable. Inline secrets remain plaintext in
the config file; restrict its permissions, never commit/share it, and keep it
outside any agent-readable directory. Credentials are not included in task specs,
health output or normal startup logs. The Web UI control token still uses its
environment variable; this option only applies to channel credentials.

If using the environment-variable configuration above, set secrets in the same
PowerShell 7 process before `serve` (skip this for channels with inline credentials):

```powershell
$env:MAYBECLAW_TELEGRAM_TOKEN = Read-Host -MaskInput "Telegram Bot Token"
$env:MAYBECLAW_FEISHU_SECRET = Read-Host -MaskInput "Feishu App Secret"
pnpm maybeclaw serve --config C:\work\may.config.json
```

**Telegram:** create a bot through [BotFather](https://t.me/BotFather), use its bot
token, and allowlist your numeric Telegram user ID as a string (not a username).
You can obtain your ID from the bot's own private-message `message.from.id` in
`getUpdates` while MaybeClaw is stopped; do not share bot tokens with ID-lookup
sites. This adapter uses [Bot API long polling](https://core.telegram.org/bots/api#getupdates),
persists the inbox and offset before advancing acknowledgement, and ignores
group/edited/non-text messages. A configured webhook produces `webhook-conflict`;
MaybeClaw will not delete someone else's webhook. Use one receiver per bot.
The host needs outbound network access to `api.telegram.org`; there is no built-in
proxy configuration. Authentication/polling conflicts stop that receiver;
transient read failures use bounded backoff and respect Telegram's retry delay.

**Feishu:** create an enterprise self-built application in the
[developer console](https://open.feishu.cn/app/), enable its bot, and record App ID
and App Secret. Grant permission to receive private bot messages and send messages
as the bot, following the platform's [receive-message](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)
and [send-message](https://open.feishu.cn/document/server-docs/im-v1/message/create)
pages. Start the host, choose long-connection event delivery, subscribe to
`im.message.receive_v1`, and publish/authorize the app for your users. Put each
authorized user's **app-scoped open_id** (`ou_...`) in `allowUsers`; obtain it from
the platform's API debugging/event tooling, not a display name. Restart after
changing settings. The [official Node SDK](https://github.com/larksuite/node-sdk)
owns the authenticated WebSocket/reconnect protocol. The handler awaits only
durable inbox acceptance, not model execution. This adapter targets mainland
Feishu (`open.feishu.cn`), not international Lark or marketplace apps.

Both adapters accept private text messages only. Plain text creates a task;
`/start` or `/help` returns help. `/status <id>`, `/result <id>` and `/cancel <id>`
operate only on tasks created by that sender in that exact bot/private chat.
IDs are the complete 64-character task IDs. Group chats, attachments, interactive
cards and multi-turn memory are deliberately not supported. Unsupported or
unauthorized input is ignored. Text input is capped at 16,384 characters.

The durable outbox sends acceptance and terminal-result notifications separately.
Replies are bounded plain text; long results are truncated, with the full result
available in the operator Web UI. A durable send intent precedes each network
attempt. A thrown/unconfirmed send, or a crash after send intent, becomes
`unknown` and **is not automatically resent**, even for Feishu's UUID-bearing
request. This prioritizes avoiding duplicate effects over eventual delivery;
it is not exactly-once messaging. A new `/result <id>` explicitly requests a new
reply. Removed users' pending messages are suppressed; bot identity changes do
not route old replies through the new bot. Disabled adapters retain pending data.
Receiver connectivity is not proof of permission to receive every event or send.
Missing credentials show `credential-error` without disabling the local Web UI.

## Control API

All endpoints require `Authorization: Bearer <operator-token>`. Mutations require
`Content-Type: application/json`. There is no cookie or query-string token fallback.

| Method/path | Meaning |
| --- | --- |
| GET `/api/health` | Host/channel health, dispatch/inbox errors, delivery metadata |
| GET `/api/tasks` | Persisted task list |
| POST `/api/tasks` | `{ "prompt": "...", "requestId": "stable-key" }`; 202 new / 200 duplicate |
| GET `/api/tasks/<id>` | Task, cancellation intent and owner/evidence metadata |
| POST `/api/tasks/<id>/cancel` | `{}`; durable cancellation request |
| POST `/api/tasks/<id>/recover` | `{}`; reconcile evidence, never replay |
| POST `/api/tasks/<id>/dispatch` | `{}`; clear pre-dispatch error so queued work can be considered again |

The CLI can use the same backend without reading model credentials:

```powershell
pnpm maybeclaw task submit "Explain these requirements." --request-id web-1 --server http://127.0.0.1:3939
pnpm maybeclaw task list --server http://127.0.0.1:3939
pnpm maybeclaw task result <id> --server http://127.0.0.1:3939
```

`--server` rejects local config/model/read/data-directory/enqueue overrides.
Client `task run` requests asynchronous dispatch; it does not await a terminal
outcome. Prefer `--server` while the host is running: standalone foreground
commands compete for task ownership and are outside the host's concurrency limit.
API request IDs occupy an `api:` namespace and channel events a
`channel:` namespace, separate from standalone request IDs. API duplicates
preserve the original model/scope/budget; changing the prompt is a conflict.

## Configuration and permissions

Submission accepts `--config <path>`, `--model <profile>` and
`--read-directory <path>`. Every command accepts `--data-directory <path>`;
the default is `~/.may/maybeclaw`. Later commands must use the same data directory.

With no read directory, the agent receives no tools. An explicit directory grants
the existing workspace-bounded `read` tool only: at most 256 KiB per file and
200 lines per call, with bounded offset/limit reads. Existing coding-tool path,
symlink containment checks apply; read access permits hard links by default. There is no arbitrary file discovery tool.
The task data directory must not overlap the read directory in either direction.
The read directory is canonicalized and checked again before execution.

This is a read permission boundary, not an OS sandbox. There is no automatic
secret-file filter: a permitted directory can contain sensitive text, which may
be included in provider requests and durable history. Do not grant your home or
credential directory; use a dedicated input directory. Files are read live, not
from an immutable snapshot. Source documents are data, not trusted instructions.
MaybeClaw does not load MaybeCode's project instructions, MCP settings or Skills.

Model configuration is pinned by profile and a digest of the adapter, endpoint,
model, options and limits. Task records do not contain provider keys or raw model
option values. Credential rotation is allowed, but changing the bound model
configuration blocks a queued run before dispatch. Restore it or submit a new
task after reviewing the new configuration. Status/result/list/recovery and
returning an already terminal task do not load credentials or invoke models.

Default run limits are 12 steps/model calls, 24 tool calls, 3 minutes and
131,072 total tokens. Configured model output is capped at 4,096 tokens per call,
or a smaller profile limit. Native automatic compaction is disabled. Token limits
are checked at response boundaries, not an upstream billing reservation; a model
that omits required usage fails with `RUN_BUDGET_USAGE_UNAVAILABLE`.

Add this application setting to your existing config to tighten limits:

```json
{
  "apps": {
    "maybeclaw": {
      "runBudget": {
        "maxDurationMs": 60000,
        "maxModelCalls": 6,
        "maxTotalTokens": 65536
      }
    }
  }
}
```

This fragment is not a complete provider configuration. Overrides can only
tighten defaults. The accepted budget is persisted; a later tighter host budget
blocks an old queued task rather than silently retaining looser permissions.
There are no per-task CLI budget overrides.

## Cancellation, status and recovery

```powershell
pnpm maybeclaw task cancel <id>
pnpm maybeclaw task recover <id>
```

Cancellation first records a durable intent. A running owner polls it; an idle
unsubmitted task can become `cancelled` immediately. The request cannot undo
provider calls or prove that an external operation never occurred. A task that
already completed keeps its completed result. Unknown execution remains
`blocked`, even when cancellation was requested.

`status` reports the last persisted snapshot, cancellation intent, owner lock
metadata and private Session evidence path. It does not repair logs, contact
providers or take execution ownership. A stale `running` snapshot is possible
after a crash. `recover` acquires ownership, checks Session evidence and updates
the projection without starting a model or replaying any input:

| Evidence | Recovery |
| --- | --- |
| Queued task, no Session/input yet | Remains queued, or cancelled if requested |
| Owned Session exists with no submitted input | Safe to return to queued |
| Matching durable terminal Run | Restore completed/failed/cancelled outcome |
| Submitted input without a terminal result | Block; never resubmit automatically |
| Missing Session after execution intent | Block; missing evidence is not permission to retry |
| Conflicting/corrupt complete records | Reject recovery and preserve evidence |

Logs have an 8 MiB per-task projection limit. Only a final unterminated record
can be discarded under the writer lock. Read-only inspection ignores such a
tail without truncating it. Session storage follows May's existing recovery
rules. Writes are synced before acknowledgement, but this is not a guarantee
against filesystem rollback, hardware loss or all power-failure scenarios.

Locks are never stolen automatically. After a process crash, use the owner PID
and hostname shown by `status` to verify that the old process has stopped. Only
then manually remove that task's exact `.lock` file and run `recover`. Never
delete task/Session journals to force a retry. This preview has no automatic
PID-based unlocking, reconciliation approval UI or retry of a submitted task.
Investigate blocked evidence before explicitly deciding whether a new task is
safe; a new request ID is not evidence that a repeat operation is harmless.

## Result semantics and storage

Execution states are `queued`, `running`, `completed`, `failed`, `cancelled` and
`blocked`. `completed` means a durable final Agent response exists, not that its
claims are correct or a business goal was independently verified. All snapshots
have `verification: "unverified"`. Delivery is tracked separately: a terminal
printing or channel error does not rerun the task, and `result` retrieves saved text.
Output is JSON-encoded rather than interpreting model text as terminal escapes.

Exit codes: `0` for successful queries, accepted submissions/cancellations and
queued/completed execution snapshots; `1` for unavailable results, operational
errors and failed/cancelled/blocked executions; `2` for CLI syntax errors.
Duplicate submit returns `0` for the accepted lookup even if its old task failed;
inspect the returned status. Pre-dispatch configuration/access errors leave the
task queued. Status/query success does not mean task success.

Private storage under the data directory:

```text
tasks/<id>.jsonl     Task specification and state/result projections
tasks/<id>.lock      Exclusive local execution owner
tasks/<id>.cancel    Monotonic cancellation intent
sessions/           May FileSessionStore execution evidence
host.lock           Exclusive local server owner
channels.jsonl      Inbox identities/ownership, Telegram cursors, outbound send evidence
```

Task journals are the source for accepted input/host state; Session journals are
the source for execution outcomes. There is no cross-file transaction: stable
task/input identities plus evidence reconciliation handle the handoff. Each task
owns one Session and at most one submitted input in this version. State is
plaintext private host data, not encrypted or multi-tenant storage. Logs can
contain prompts, file content, answers and provider error details. Retention,
backups and directory access controls remain host responsibilities.

The channel journal is limited to 32 MiB, with a maximum of 100 unprocessed inbox
events at admission. There is no automatic journal compaction/retention yet.
Reaching the limit stops further durable acceptance; preserve journals/cursors
and plan an explicit migration, rather than deleting deduplication evidence.
Private file modes are best-effort; use account-level ACLs on Windows.

## Architecture and next steps

The public product API is `MaybeClaw.submit/run/status/cancel/recover`; its
`FileTaskStore` also supports listing. `TaskSpec` and the local journal are
independent of CLI/channel payloads. `loadModel` is a trusted host callback;
non-CLI hosts must enforce their own configuration/budget policy. MaybeClaw uses
`defineAgent`, `AgentApplication`, `FileSessionStore`, Provider selection and the
read tool directly, with no dependency on `apps/maybecode`.

`MaybeClawHost` owns the bounded queue; `startControlServer` supplies transport and
operator authentication; `ChannelHub` maps authenticated channel events into tasks
and persists replies through `ChannelStore`. Telegram/Feishu normalize platform
messages at the edge. CLI, Web and channels share the same task service. Product
policies remain in `apps/maybeclaw`; this does not add SDK-specific code to May Core.

Still absent: continuous Conversation routing, guaranteed eventual Outbox delivery, scheduling, persistent
user approval/waits, long-term memory, MCP, Skills, multi-agent delegation,
coding edits, sandboxing and a global budget service. Stabilize the task contract
with real usage before extracting `@may/tasks`; do not put channel policy in Core.

## Verification

```powershell
pnpm --filter @may/maybeclaw test
pnpm docs:check
```

The focused offline suite covers tool execution and duplicate input, cancellation
and competing owners, real child-process termination, incomplete/corrupt logs,
recovery without replay, model/budget binding and the actual HTTP provider adapter
against a local deterministic fixture. These are engineering checks, not live
model-quality or benchmark results.
Additional focused cases cover the real loopback server, API auth/Host/Origin,
concurrency, graceful shutdown/restart, channel ownership/deduplication, unknown
send recovery and both adapters' mocked platform protocols. The browser flow is
also checked with a deterministic local model. Without real credentials these
checks do **not** establish live Feishu/TG event subscription or delivery success.

## Journal maintenance

Task journals checkpoint the complete current state before accumulated snapshots fill the
8 MiB limit. Channel journals compact repeated versions of records before the 32 MiB limit.
Inbox identities, delivery receipts and unknown outcomes are retained; compaction never
resends a delivery. Unique retained records still consume space and require stopped-host
archival if the current state alone reaches the cap. Checkpoints require the current reader.
Library callers of `runMaybeClaw` must supply `dependencies.signal` in serve mode to support
explicit shutdown.

Local request keys accept up to 128 characters. The HTTP API accepts up to 100 before
adding its `api:` namespace; use that bound with `--server`. These are deliberately distinct
idempotency namespaces, not interchangeable task identities.
