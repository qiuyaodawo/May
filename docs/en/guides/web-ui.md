# Use the shared Web UI

**English** | [简体中文](../../zh-CN/guides/web-ui.md)

Use the browser workbench to send messages, inspect history, resolve approvals
and manage product resources. MaybeCode and MaybeClaw share browser components
and transport; their hosts retain execution, permissions and persistence.

For MaybeCode, you need a configured model and an open coding workspace. For
MaybeClaw, you need a local administrator account and an Agent configuration;
the first-run setup can create them. Repository commands below run from the
repository root using the pnpm version declared in `package.json`.

## Run

### Open an existing MaybeCode workspace

1. In either MaybeCode terminal interface, enter `/web`.
2. The command selects a loopback port and opens the current workspace and Session
   in the default browser. The page connects automatically.
3. After refreshing or disconnecting the page, execute `/web` again.
4. Close a browser page to disconnect it. Exit the terminal to close both the
   Agent and Web service.

The terminal and Web receive their own live-event streams and share one
controller. A message, approval, model change or Session change in either
interface appears in both. MCP interactions can be answered from either
interface; resolving one removes the request from all connected views.

The launch URL contains a one-time ticket in its fragment. The page removes the
fragment and exchanges the ticket for a control token. Tickets last 60 seconds,
can be consumed once and have an eight-ticket pending limit. Control tokens
remain in page memory. Authentication and Origin checks apply to every request.

### Start a standalone MaybeCode Web host

1. Use your existing May model configuration. In PowerShell, generate a token,
   copy it for the connection dialog and start the host:

```powershell
$env:MAYBECODE_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
Set-Clipboard $env:MAYBECODE_CONTROL_TOKEN
pnpm maybecode --ui web --port 3940
```

2. Open the printed address, select **连接本地服务** and paste the token.
   Clear the clipboard after connecting. A page reload requires reconnection.
3. Stop the host with Ctrl+C. Remove the token from the launching shell when
   finished:

```powershell
Set-Clipboard -Value ""
Remove-Item Env:\MAYBECODE_CONTROL_TOKEN
```

`--continue` and `--resume` select Session history as in the terminal.
`--port` requires `--ui web`; `0` selects an available port. The default interface
is `retained` TUI. Tokens are not written to browser storage or static assets.

### Start MaybeClaw

```powershell
pnpm maybeclaw
```

The command starts the local service and opens the default browser. If
configuration or administrator authentication is missing, complete the local
password setup. It preserves existing May settings and saves a password hash.
Log in, select **Agent 管理** → **添加 Agent**, and create a Session.

`--no-open` or the `serve` subcommand starts the service without opening a browser.
When setup is required, open the local initialization HTML file printed by the
terminal. Ctrl+C stops the service. Password changes invalidate existing logins.
See the [MaybeClaw guide](maybeclaw.md) for password requirements, login lifetime
and remote CLI authentication.

## MaybeCode commands and interactions

The composer shares the terminal slash-command registry. Arrow Up/Down selects a
completion and Tab inserts it. Unknown commands and invalid arguments produce
command errors. Management output remains in page memory outside conversation
history.

| Task | Web entry |
| --- | --- |
| Select model/default profile | Model dropdown; `/model`; `/model profile --default` |
| Select reasoning effort | Effort dropdown; `/effort`; `/effort default` |
| Manage Sessions | Sidebar; `/new`, `/resume [id]`; rename and confirmed deletion |
| Retry or inspect execution | `/retry`, `/instructions`, `/status`, `/context` |
| Manage goals | `/goal start`, `status`, `pause`, `resume`, `cancel` |
| Compact Context | `/compact [history-reference\|provider-native]` or compact button |
| Use Skills | `/skills`, `/skills show name`, `/skills use name [task]` |
| Use MCP | `/mcp` catalog, resource, prompt, watch and task commands |
| Investigate recovery | `/recovery`, `/recovery resolve id finding` |
| Read details | `/details`, `/thinking`, transcript search and inspector |
| Exit the host | `/quit` or `/exit`, then confirm |

An ordinary message cancels active execution, waits for cancellation and starts
the new request. `/steer <message>` saves FIFO input for the next complete Step
boundary, including its tools and approvals; idle steering starts a Run.
`/stop` and the cancel control cancel active work and queued input. Cancelled
input needs explicit resubmission. Delivered steering text appears once and
remains available after reopening the Session.

MCP forms and editable reviews show the exact JSON submitted and require
confirmation. URL requests require consent, manual navigation and an explicit
retry action. Responses and cancellation remain available while a command waits.
The broker checks schema, ownership and expiry; responses stay outside history.
Standalone Web mode enables the same broker. `team` and `mcp login` keep their
separate CLI entry points. See [MCP interactions](mcp.md#scoped-user-interaction-modern-mrtr).

## Session forks and file versions

Workspace hosts show the current Git branch in the header; detached HEAD shows
a short commit hash. Historical replies retain their recorded branch and commit.
External Git changes and Session switches update current workspace information.

After a completed reply, select **创建分支** and choose the workspace mode.
The current workspace retains its files. A new worktree begins at the reply's
recorded commit. Forking requires recoverable Session state; worktree creation
also requires a recorded file version. In-progress messages cannot be selected.

**本轮文件变化** shows that reply's changes. Header **查看文件变化** provides
Session-wide and current-workspace comparisons. Added, modified, deleted and
binary files have explicit states; text diffs support search and change navigation.
Uncommitted changes are labeled as current workspace content.

To restore a file, select **预览恢复**, inspect the restoration diff, then select
**确认恢复文件**. A manual change after preview causes a conflict and prevents
restoration. **管理 worktree** provides registered paths, branches, starting
commits and open/delete actions. The host checks linked Sessions, processes,
uncommitted changes and unmerged commits before directory deletion.

The TUI exposes the same tasks through `/fork` and `/changes`. In `/fork`, use
arrows to navigate, `/` to search, Space to preview, Enter to select and Escape
to cancel. In a diff, Page Up/Down scrolls, `/` searches, `N` finds the next match,
`]` selects the next change, `R` previews restoration and `Y` confirms it.

Custom hosts supply optional `workspace`, `forkPoints`, `checkpoints` and
`worktrees` snapshot fields. Operations use `session.fork`, `changes.view`,
`worktree.open`, `worktree.delete`, `changes.restore.preview` and
`changes.restore.apply`. `UiWorkspaceDiff.restorePreviewId` identifies a
host-retained preview. Controls appear only for supplied capabilities.

## Read history and details

The transcript groups records by Run and shows tool counts, approvals and exceptional
states. Expand/collapse and exception filtering affect the local view. Approval
controls remain accessible. New output preserves the visible history position
and offers **有新内容 / 回到最新**.

**查看详情** opens a side panel for overview, input, output, errors and presentation
fields. Read-only fields provide previous/next chunks and refresh. The host binds
field content to its resource and version hash, rejecting mixed-version reads.
The overview can use product renderers such as Diff; large presentation JSON is
available as raw text chunks.

The sidebar searches all Session titles or task prompts and pages by creation
time plus stable ID. Adding, deleting or renaming resources refreshes loaded pages
while preserving the query and page count. `snapshot.resourcesVersion` lets a
host invalidate pages for changes anywhere in the catalog. Without it, changes
to snapshot resource IDs or titles trigger refresh.

**搜索内容** searches committed user/assistant text, reasoning, tool inputs/results,
diagnostics and presentations, including content beyond previews. Results are
matching blocks and refresh when searching again. Loading old pages keeps current
approvals and does not activate another Session.

Custom hosts declare `snapshot.reads` and optional `UiHost.resources`, `history`
and `field`. Authenticated routes `/api/ui/resources`, `/api/ui/history` and
`/api/ui/field` require current `hostId`; history/field also require `selected`.
Pages accept `query` and opaque `cursor`, return at most 50 records and target an
approximately 256K-character payload. A single bounded large block can exceed
that budget. Cursors bind host/resource/query/anchor. Deleted anchors or scope
changes require a fresh search. Old host or selection responses are discarded.

`AgentWorkspace.readSessionHistory()` validates catalog membership and calls
`SessionStore.inspect()`. It reads without activating a runtime, updating recency
or repairing the journal. The file store ignores incomplete trailing bytes and
rejects malformed complete records. Custom stores must supply safe inspection.
MaybeClaw also verifies task ownership. Existing catalogs and journals are scanned
in memory; very large histories and many loaded pages still consume CPU and memory.

## Execution evidence and approvals

Tool cards show waiting, running, completed, failed, denied, not-started and unknown
states. A started tool without a confirmed result remains unknown after cancellation.
Explicit host recovery evidence can establish not-started. Partial assistant answers
are labeled interrupted. Progress provides live display; durable completion is
recorded separately.

Only current `snapshot.interactions` creates decision controls. History retains
read-only approval evidence. The host rejects expired or unavailable choices.
Session-wide approval requires a grant key. Truncated approval inputs are deny-only.

Persistent approval requires host-provided scope metadata and operator identity.
`ApplicationUiHost.permissionActor()` supplies that identity; clients cannot supply
it. Optional `permissionRules: { list, revoke, create? }` callbacks implement
`permission.rules.list`, `revoke` and `create`. A create request supplies an
existing visible rule ID and allow/deny decision; the host derives the full range
and operator. Confirmation displays the complete range and deny precedence.
`UiPanel.actions` enables these actions in standard or product detail panels.

## Models and diagnostics

MaybeCode's model panel shows known, unknown and unsupported capabilities, sources,
discovery diagnostics and refresh. Its active Session diagnostic panel uses the
optional observability plugin. MaybeClaw provides `agent.check` and
`session.diagnostics`; authentication and Session ownership checks also apply.

`@may/ui-client.createTelemetryPanel(data)` displays at most 40 records with
individual durations, status, parent identities, sampling and retention coverage.
Hosts can page diagnostics independently. See
[model and telemetry integration](model-telemetry-integration.md).

## Integrate a custom host

| Package or layer | Responsibility |
| --- | --- |
| Application/product host | Execution, permissions, budgets, persistence and recovery |
| `@may/ui-client` | JSON types and browser connection/state synchronization |
| `@may/ui-client/application` | Single-active-Session workspace adapter |
| `@may/ui-client/server` | Loopback HTTP, authentication, Origin checks, receipts and SSE |
| `@may/web-ui` | Workbench and reusable transcript, composer, approval and detail components |
| Product extensions | File diffs, task lifecycle, delivery and domain-specific presentation |

Implement `UiHost`, or connect `ApplicationUiHost` to an `AgentWorkspaceController`.
Browser modules use browser-safe exports; Node adapters belong in the host.
Static modules are served from a fixed asset map.

When a terminal owns execution, supply independent `events` and
`closeApplication: false` to `ApplicationUiHost`. The terminal distributes events
and closes the controller. Pair `startUiServer({ browserLogin: true, ... })` with
`webUiAssets(..., { browserLogin: true })`; `createLoginUrl()` issues a connection
ticket. Product routes can use `BrowserLogin` from `@may/ui-client/server` through
`issue()`, `redeem()` and `clear()`. Custom shells can supply `initialToken` and
`connectionHint` to `mountWebUI`; the launcher then supplies login instructions.

Hosts that provide `snapshot.controls` set `busy` while their selected resource
has an active operation, including pending interactions. The workbench shows
the cancel action during that activity or a pending client command when
`commands` includes `controls.cancelCommand`. When idle, it shows the send
action. Enter submits and Shift+Enter adds a newline. Slash commands require
`controls.inputCommand`; ordinary messages require `message.submit` or, for a
new task, `task.submit`. Entering supported input during host activity also
shows the send action alongside cancellation. A pending client command must
finish before another composer submission. MaybeCode includes Runs,
Context compaction and MCP interactions. MaybeClaw includes queued, running,
waiting and cancelling tasks in the selected Session.

`ApplicationUiHost` supports `controls`, `complete`, `available`, `submit`,
`concurrentCommands` and `interactionCommands`. Interaction responses have a
separate checked path while commands wait. Products validate availability and
ownership. `UiReceipt.output` is transient command output; `disconnect` closes
the requesting page. `UiClient.interact()` can run while `command()` waits.
The server flushes an exit receipt before invoking `exit`, exposes `closed`, and
closes its host when no exit callback is supplied.

Trusted `WebUiExtensions` register `tools[toolName]`, `approvalDetails[toolName]`,
`diagnostics[code]`, `presentations[kind][version]` and `panels[id]`. They return
an HTMLElement or null and preserve standard evidence and approval controls.
Unknown types/versions, null results and extension failures retain standard display.
Model output cannot load extension code. Upgrade preview clients, hosts and
product extensions together.

`WebUiOptions.navigation` or `createNavigation()` supplies groups of typed items
with icons, labels, titles, badges, actions and disabled state. `onNew` and
`newLabel` customize creation. At `max-width: 760px`, navigation uses an overlay;
hidden panels are inert and `aria-hidden`, Escape/backdrop closes them, and focus
returns to the toggle. Tab/Shift+Tab remains within the open panel. Themes follow
the OS. Browser text currently uses Chinese.

## Protocol v1 and limits

| Route | Purpose |
| --- | --- |
| `GET /api/ui/snapshot?selected=<id>` | Capabilities, resources, selected transcript, interactions and panels |
| `GET /api/ui/events` | Authenticated SSE invalidations |
| `POST /api/ui/commands` | `{ version, hostId, requestId, name, targetId, expectedActiveId?, args }` |
| `GET /api/ui/complete` | Authenticated host/Session-bound completion |

Clients resnapshot on connect, invalidation and reconnect. A two-second heartbeat
observes external owners, and live changes are coalesced for 120 ms. Slow event
connections close; clients reconnect with backoff. Old responses cannot replace
newer state. SSE does not provide durable replay.

Commands are never automatically retried. A host-local receipt binds request ID
and content; identical reuse returns the receipt and conflicting reuse fails.
At 4,096 receipts, new commands require a controlled restart. Restart changes
`hostId`, so uncertain old requests fail. Inspect current state before a new
request; receipt deduplication lasts only for the host lifetime.

MaybeCode displays one active Session to all pages. Session creation, activation
and deletion require idle execution without pending MCP interaction. They carry
`expectedActiveId`; stale transitions fail. The current Session cannot be deleted.
Task hosts permit independent browsing. MaybeClaw exposes final results, cancellation
intent, evidence recovery, failed-dispatch retry, channels and the latest 100
delivery records. Its live projection retains eight tasks; saved Session journals
provide historical tool results after restart. Task, verification and delivery
policy remain product-owned.

The server binds to `127.0.0.1` for a local single operator. Keep it local.
Request bodies allow 256 KiB and argument strings 65,536 characters. Snapshots
show at most 50 recent blocks and approximately 64K-character previews; field
reads return 32,768-character chunks. Provider continuation state remains private.
Tool details are sensitive authenticated workspace data. File browsing and artifact
downloads are unavailable.

Markdown supports paragraphs, headings, lists, quotes, code, tables, bold and
HTTP(S) links. Raw HTML, remote images, generated scripts and executable previews
are disabled. Recovery uses the current execution owner; each Session has one
runtime owner.

## Verification

After `pnpm build`, the local browser suite runs against the workspace, catalog,
UI host and HTTP service:

```powershell
pnpm --filter @may/web-ui exec playwright install chromium
pnpm --filter @may/web-ui test:browser
```

These checks include resource paging/search, additions/deletions/renames, retained
page state and expired cursors. Browser work stays under ignored `review/`.
Checks that require configured providers have separate prerequisites:

| Check | Required flags and command |
| --- | --- |
| MaybeCode controls and shared terminal/Web | `MAYBECODE_WEB_LIVE=1`; `pnpm --filter @may/maybecode exec node --test test/integration/web-controls.test.mjs test/integration/web-terminal.test.mjs` |
| Workspace file versions | `MAY_LIVE_PROVIDER_UI_TESTS=1`; `node --test packages/ui/web/test/browser/workspace-versions.test.mjs` |
| Session fork and isolated test commits | Both `MAY_LIVE_PROVIDER_UI_TESTS=1` and `MAY_GIT_CHECKPOINT_TEST_COMMITS=1`; `node --test packages/ui/web/test/browser/workspace-session-fork.test.mjs` |

The file-version check initializes the configured Model and checks Git and the
page. Tests that submit messages use configured credentials and consume provider
quota. Workspace checks require the configured `deepseek-v4-flash` profile. The commit flag
authorizes commits only in the test's isolated repository/worktrees. Tests skip
without their required flags. Report actual execution, layout, external delivery
and recovery checks separately; a passing local test does not establish all of them.
