# MaybeClaw: Agent Gateway

**English** | [简体中文](../../zh-CN/guides/maybeclaw.md)

MaybeClaw connects Agents to durable sessions, Web, CLI, Telegram, and Feishu.
It manages routing, access, approvals, execution, and message delivery.

Reusable channel, delivery, Agent adapter, coordination and HTTP functionality
is provided by `packages/plugins/`. Product plugin composition lives in
`apps/maybeclaw/src/plugins/`; AgentGateway and GatewayHost manage the complete
application lifecycle. Configured plugins may replace default Model and
PermissionPolicy providers. Idle adapters are released through their registry
and recreated from current configuration when needed. Shutdown starts cancelling
Gateway work before waiting for HTTP requests and releasing resources. See the
[plugin guide](plugins.md#reusable-plugin-packages).

## Sessions and configuration

`pnpm maybeclaw --help` and `pnpm maybeclaw -h` print help and exit successfully.
The CLI handles these options before loading its runtime modules, reading configuration,
or initializing SQLite.

A session requires a name and one or more default Agents. An optional chat
entrance binds it to a private identity or one platform group/topic. Optional
allowed Agents can have conversations created without approval; default Agents
automatically join that list. Each allocated Agent conversation belongs to one
MaybeClaw session. The same Agent definition can serve several sessions using
separate conversation IDs. Conversations are created when needed.

Run `pnpm maybeclaw` from the repository root. If the configuration file, MaybeClaw
configuration, or administrator authentication is missing, a local initialization
page asks you to set and confirm a password of 10–1024 characters. It writes
`version: 2`, `agents: []`, and an Argon2id `passwordHash`, preserving existing
configuration. It then opens the console at the same address; log in, add an Agent,
and create a session. New files also contain an empty `providers` object.

Initialization requires a one-time credential automatically supplied to the browser.
With `--no-open` or `serve`, open the local initialization HTML file printed by the
terminal. Keep this file private; it is removed after setup or normal shutdown.
Refreshing the setup page clears its credential; reopen the initialization file to retry.
Only the local origin is accepted during initialization. Existing valid configuration
starts normally. Old configuration requires explicit migration; malformed configuration
is reported without changes. Concurrent initialization of the same file is rejected.
If a process is forcibly terminated, confirm it has stopped before removing its
`<config-path>.initialize.lock` and leftover `*.initialize.html` files to restart setup.

For manual configuration, retain existing May `providers` and `models` and merge:

```json
{
  "apps": {
    "maybeclaw": {
      "version": 2,
      "agents": [],
      "server": {
        "auth": {
          "password": "REPLACE_WITH_YOUR_OWN_PASSWORD"
        }
      }
    }
  }
}
```

After starting the Web console, log in using the administrator password and add the first Agent in Agent Management. You can then create sessions immediately without restarting the service. Existing `providers` and `models` configurations are retained for May Agents.

A configuration with pre-registered Agents is shown below. Replace `coding-profile` and `review-profile` with actual model profile names.

```json
{
  "apps": {
    "maybeclaw": {
      "version": 2,
      "agents": [
        { "id": "code", "adapter": "may", "model": "coding-profile" },
        { "id": "reviewer", "adapter": "may", "model": "review-profile" }
      ],
      "server": { "maxConcurrent": 4, "idleMs": 600000, "shutdownMs": 30000, "approvalMs": 600000, "auth": { "password": "REPLACE_WITH_YOUR_OWN_PASSWORD" } },
      "access": { "sessionAdmins": {}, "creators": [], "deniedUsers": [], "allowedAgents": {} }
    }
  }
}
```

May Agent configuration supports `model`, `instructions`, `readDirectory`,
`permissions`, `runBudget`, and `idleMs`. External adapters declare creation,
execution, inspection, cancellation, steering, recovery, deletion, approvals,
collaboration, and media capabilities. Unsupported operations report an error.
`agent check <id>` loads the adapter and reports its capabilities; successful
loading does not prove a model request or chat delivery.
Agent status reports `unloaded`, `loading`, `loaded`, `unavailable`, `releasing`,
`reconfiguring`, or `disabled`. Loading failures remain visible until another
check succeeds or the configuration changes. Idle release returns to `unloaded`;
the saved conversations remain available for recovery.
An unexpected background-processing failure marks the service `degraded`,
exposes the reason to administrators, and stops scheduled processing. Correct
the reported condition before restarting the service.

## Persistent permission rules

Set `apps.maybeclaw.persistentRules: true` to enable saved permissions. The
default is `false`. One lazily opened `FilePermissionRuleStore` owns
`<data-directory>/permission-rules.json`; all May adapters share it. Normal
Gateway shutdown closes adapters before releasing the rule writer lock. Cleanup
failure preserves rule-store ownership for investigation. A leftover `.lock`
requires checking that its owner has stopped; the runtime never takes it over
automatically. File tools deny access to the rule file, its ownership file and
replacement files, including directory links that resolve to those paths.

The built-in policy gives `read` an exact canonical file scope. Other tools
configured with `permissions[toolName]: "ask"` or `"allow"` receive a scope for
the current exact input, represented by a SHA-256 key. Exact input must support
lossless JSON serialization and parsing; values such as nonfinite numbers,
`undefined`, sparse arrays and negative zero fail permission evaluation.
Scope also includes the
Gateway data directory, Agent, canonical `readDirectory`, and initiating operator
or platform user. Rule records retain descriptions and keys; they omit original
tool arguments. Unconfigured tools requiring approval keep per-request approval.
Explicit `deny` remains effective. Custom PermissionPolicy plugins must provide
their own verified persistent scopes and protect the rule-store files.

An eligible approval displays its complete scope and offers
`allow-persistent`. Only the service administrator may choose it. The terminal
uses the same choice; `/approve <id> --persistent` also saves an eligible rule.
Session administrators retain their existing per-request and `allow-session`
choices. Save failure prevents tool execution. Already saved permissions are
checked again on every call, including after restarting the service.

The Web manager's **Persistent permission rules** page lists rules, revokes
them, and creates an allow or deny rule from an existing scope. It accepts a
source rule ID and a decision. The Gateway verifies the source Agent, project,
identity and expiry; clients cannot submit replacement scope fields. Deny rules
take precedence, so restoring an operation requires revoking matching deny rules.
Management changes are recorded in `gateway.sqlite` under
`permission-rule-events`. Execution, rule usage and approval events remain in
their Agent Session histories.

Authenticated administrator APIs provide `GET /api/permission-rules`,
`POST /api/permission-rules` with `{ sourceId, decision }`, and
`POST /api/permission-rules/<id>/revoke`. The equivalent UI commands are
`gateway.inspect` with `kind: "permission-rules"`, `permission.rule.create`, and
`permission.rule.revoke`. These are host management interfaces.

## Startup, Web, and CLI

Run `pnpm maybeclaw` to start the Web control service and open the default browser
at its initialization or login page.
You can create your first session in the Web manager. With no subcommand,
`--config`, `--port`, and `--data-directory` configure startup; `--no-open` disables
browser opening. `serve` starts only the service. Keep the terminal running;
Ctrl+C stops the service.

```powershell
pnpm maybeclaw
pnpm maybeclaw --config may.config.json --port 3939
pnpm maybeclaw session create "Project review" --agent code --allow-agent reviewer --config may.config.json
pnpm maybeclaw session list --config may.config.json
pnpm maybeclaw serve --config may.config.json --port 3939
```

For manual password configuration, set `apps.maybeclaw.server.auth.password` to your password
of 10–1024 characters. Spaces are preserved. Startup replaces this field with
`passwordHash`, an Argon2id hash with a random salt. While running, the service
checks saves every 500 ms and before authenticated requests. To change the password,
add `password` alongside the generated hash and save. The service removes the
plaintext field and invalidates existing logins and event streams. A stopped
service performs the conversion at its next startup. File conversion does not
remove plaintext from editor history or backups; protect those separately.
Invalid authentication configuration rejects authenticated access until corrected.
The server prints its URL and channel status without credentials.
The default data directory is `~/.may/maybeclaw`; `--data-directory` overrides it.

The control server listens on `127.0.0.1`, authenticates API requests, checks Host
and Origin, and applies CSP. Its credential grants service administrator access.
Enter the original password in the Web login form. Browser login credentials stay
in page memory; reload requires login again. `server.auth.sessionMs` sets their
lifetime (default 28800000 ms, range 1000–86400000 ms). Disconnecting logs out;
restarting the service invalidates every login. You can start the Web service
with no sessions, then create a session through its manager.

Remote CLI commands read the password from `MAYBECLAW_ADMIN_PASSWORD` or the
variable selected by `--password-env <name>`, log in, and log out after completion.
Local commands use filesystem access. API clients POST `{ "password": "..." }`
to `/api/auth/login`, use the returned `token` as a Bearer credential until
`expiresAt`, and POST `/api/auth/logout` with that credential to revoke it.
The hash cannot be used as a login credential. Login verification allows two
concurrent requests and ten attempts per minute; successful login clears the
attempt counter. Each service supports up to 128 concurrent logins.

For access from another device, configure `server.publicOrigin` with an exact
HTTPS origin such as `https://gateway.example:8443`. Put an HTTPS reverse proxy
in front of the loopback listener and preserve the browser's Host header and
Origin. Proxy all paths to that listener and allow streaming responses for UI
events. Only the local origin and the configured public origin pass the paired
Host/Origin check; forwarded headers do not authorize another host. The API still
requires administrator login. Protect the proxy with your deployment's access controls.
Use its canonical spelling: no trailing slash, path, query, fragment, user
information, or explicit default `:443` port.

The Web manager supports graphical creation and “直接使用命令创建” with the same
Gateway commands and validation. A session must exist before ordinary messages
are sent. Browsing sessions changes only the current page; changing the platform
entrance default is a separate management operation. Session-wide default Agent
changes apply to every authorized participant and interface. The manager also
provides Agent configuration, entrance binding, session administrators, approvals,
channel status, and independent historical task inspection.

```powershell
pnpm maybeclaw task submit "Review the changes" --session <session-id> --agent reviewer --server http://127.0.0.1:3939 --request-id review-1
pnpm maybeclaw task status <task-id> --server http://127.0.0.1:3939
pnpm maybeclaw task result <task-id> --server http://127.0.0.1:3939
pnpm maybeclaw task cancel <task-id> --server http://127.0.0.1:3939
pnpm maybeclaw session rename <session-id> --name "Release review" --server http://127.0.0.1:3939
pnpm maybeclaw agent save reviewer --definition reviewer.json --server http://127.0.0.1:3939
pnpm maybeclaw channel status --server http://127.0.0.1:3939
```

Use `--server` while `serve` owns the data directory. Direct commands require its
exclusive owner lock. Local submission waits for completion and interactive
foreground approval decisions; server submission returns when accepted and work
continues after the client exits. `task recover` checks the named task's evidence;
`task run` dispatches its eligible coordination graph. Unknown tool results
require reconciliation. Model and directory options belong in Agent configuration.

For interrupted May tools, send `/agent command <agent> recovery` within the
affected session to list unresolved operations. After verifying their actual
outcome, `/agent command <agent> resolve-recovery <id> <verified outcome>` records
the evidence. `task recover <task-id>` then inspects the original task without
replaying its tools. Further work is submitted as a new input.

Versioned JSON routes under `/api/v2` include `sessions`, `tasks`, `agents`,
`approvals`, `commands`, and `health`. Task submission requires `sessionId`,
`prompt`, and `requestId`. Repeated accepted task input uses the original receipt;
changing the payload under the same identity is rejected.

## Chat commands and interruption

```text
/session create "Project review" --agent code --allow-agent reviewer
/session list
/session select "Project review"
/session "Project review" @reviewer Check error handling
/agent default reviewer
/steer Also inspect permission checks
/stop --task <task-id>
/history --before <sequence>
```

Explicit targets take precedence over native reply associations and entrance
defaults. `/session A message` targets one message; `/session select A` changes
the entrance default. `/agent default` changes the session-wide default;
`@agent` targets one message. `/new` and `/resume` use Gateway session management.
Adapter-specific commands use `/agent command <agent> <command>` and declared support.

Ordinary input interrupts its authorized target and waits for cancellation before
starting another execution. `/steer` lets the current Step finish, then delivers
FIFO input before the next model request. Approvals continue waiting. Input left
after normal completion starts subsequent work; cancellation preserves it for
explicit resubmission. Unsupported capabilities return clear errors.

## Channels, members, and approvals

Add channels under `apps.maybeclaw.channels`:

```json
{
  "telegram": { "enabled": true, "botTokenEnv": "MAYBECLAW_TELEGRAM_TOKEN", "allowUsers": ["123456789"], "allowGroups": ["-1001234567890"], "groupTrigger": "explicit" },
  "feishu": { "enabled": true, "appId": "cli_replace_with_your_app_id", "appSecretEnv": "MAYBECLAW_FEISHU_SECRET", "allowUsers": ["ou_replace_with_your_open_id"], "allowGroups": ["oc_replace_with_your_chat_id"] }
}
```

Enabled channels require an explicit allowed-user or allowed-group list. Groups
normally trigger on mentions, replies to Gateway messages, commands, or explicit
targets. Dedicated groups can use `groupTrigger: "all"`; `entranceTriggers`
overrides particular groups/topics. The platform determines which events arrive.

Membership changes revoke the departing member's group access and cancel their
active work; a subsequent join event restores access within the configured scope.
Telegram subscribes to `chat_member`; the bot must be a group administrator for
Telegram to deliver these updates. Feishu requires the bot to be in the group,
group-information permissions, and subscriptions to
`im.chat.member.user.added_v1`, `im.chat.member.user.deleted_v1`, and
`im.chat.member.user.withdrawn_v1`. Membership events cover every topic in the
group. Older events cannot replace newer membership state. Events unavailable
because of platform permissions cannot establish a membership change; service
administrators can revoke access through `access.deniedUsers`.

Service administrators assign session managers through `access.sessionAdmins`
or the manager, using keys such as `telegram:<bot-id>:<user-id>`. Management
authority follows that configuration. Ordinary members participate and control
their own work. Managers control shared settings, lifecycle, and approvals.
Global restrictions remain effective during Agent creation and collaboration.

Agent creation approval and tool approval have separate scopes. A one-time
creation decision does not edit the reusable allowed-Agent list. `allow-session`
applies only to the declared grant in the corresponding Agent conversation.
Expired and duplicate approval responses grant no additional authority.
On restart, pending approvals become `cancelled`. Approvals interrupted while
`resolving` become `unknown`, retaining their `decision` and `decidedBy` for
inspection. Agent configuration updates report these uncertain approvals
immediately; verify the Agent's recorded outcome before changing its configuration.

Before dispatch, platform edits update the pending message and recalls cancel it.
After dispatch, the original execution input stays intact and an edit or recall
notice is stored in session history for the Web UI and `/history`. Platform event
IDs deduplicate these notices, and edited text retains its original whitespace.
Web message titles identify the platform account and member. Session selection
replies include active task counts, unsent message counts, and uncertain deliveries.

Replies identify their session and Agent. Channel disconnects and UI browsing
leave work running. Delivery distinguishes pending, sending, sent, and unknown
outcomes; reconnecting does not replay execution. Media requires matching Agent
and platform capabilities. Binding a control-only session requires explicit
confirmation that its existing history becomes visible to authorized participants.

May Agents explicitly declare input kinds with `media`, for example
`"media": ["image", "audio", "file", "video"]`. Only enable kinds supported by
the configured provider. Video requires its own `video` capability and is passed
as a file content part retaining its `video/*` MIME type. A `file` declaration
alone does not enable videos. RPC Agents declare the same kinds during their
capability handshake. The provider validates its actual input support.

## Lifecycle, storage, and migration

Idle resources release after the configured delay while conversation identity
and history persist. On restart, revoked access and changed policy or Agent
versions place the affected unfinished tasks in recovery-required state while
other sessions resume. Corrupt persisted state stops recovery with an error.
Disabling an Agent rejects new work and lets current work
finish. Model or startup changes drain affected work before replacing resources.
Archive requires idle work and preserves history. Deletion confirms removal of
Gateway records, dedicated Agent conversations, and unsent output; user project
files and sent platform messages have independent lifecycles. Incomplete external
cleanup remains visible.

A shared process or connection closes only when every user is idle and the adapter
supports resuming its conversations. Approval and collaboration for accepted work
continue during configuration updates. Waiting collaboration tasks, queued steering
input, and uncertain outcomes must be resolved before configuration is applied.
Shutdown cancels execution after the `shutdownMs` grace period, then waits for
input admission, conversation creation, configuration writes, and resource cleanup
before releasing the data directory.

`gateway.sqlite` stores sessions, bindings, messages, tasks, approvals, defaults,
request receipts, and delivery records transactionally. May histories remain in
Session stores. `host.lock` protects against concurrent writers; check a recorded
owner has stopped before handling an abandoned lock.

```powershell
pnpm maybeclaw migrate check --data-directory <directory>
pnpm maybeclaw migrate run --data-directory <directory>
```

Migration verifies ownership, backs up the original data, preserves independent
historical tasks and channel evidence, and records completion. Old queued work
awaits explicit assignment to a created session. Sent messages remain sent;
unknown results require reconciliation. Configure the version 2 Agent catalogue
explicitly after data migration. Real provider and platform verification depends
on the configured adapter, credentials, and network.

Service administrators inspect migrated delivery records in channel status.
After checking an uncertain send, `maybeclaw delivery retry-legacy <id> --confirm
--server <url>` explicitly accepts the possibility of a duplicate platform message
and returns that delivery to pending. The authenticated HTTP equivalent is
`POST /api/v2/legacy-deliveries/<id>/retry` with `{ "confirmUnknown": true }`.
Confirmed sent messages cannot be retried.

Current messages and channel replies use `delivery retry <id> --confirm --server
<url>` or `POST /api/v2/deliveries/<id>/retry` with the same confirmation body.
The Web channel manager provides an explicit confirmation action for uncertain
and failed deliveries. A retry changes delivery state; it does not execute the
Agent's work again.
