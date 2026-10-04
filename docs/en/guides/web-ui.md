# Shared Web UI

**English** | [简体中文](../../zh-CN/guides/web-ui.md)

MaybeCode and MaybeClaw share browser components and transport while retaining
their own resource models. MaybeCode terminal frontends open the workbench with `/web`.

## Run

In either MaybeCode terminal frontend, enter `/web` to open the current workspace
and Session in the default browser. The command automatically selects an available
loopback port and generates authentication credentials. No environment variable or
manual token entry is needed. Repeating `/web` reuses the service and opens another
authenticated page. After refreshing or disconnecting a page, run `/web` again.

TUI and Web receive separate copies of live events and share the same execution
owner. Messages, approvals, model changes and Session changes use the same
controller. An approval resolved in either frontend disappears from both.
Closing a browser page leaves the Agent running; exiting the TUI closes the Agent
and Web service. MCP forms and authorization interactions can be completed in
either frontend; a resolved request disappears from both.

The connection link carries a one-time ticket in its URL fragment. The page
immediately removes the fragment and exchanges the ticket for a control token.
Tickets expire after 60 seconds, are consumed once, and are limited to eight
pending connections. The token stays in page memory and is never printed or
written to browser storage. Origin checks and Bearer authentication remain active.

To launch a standalone Web host, use the following command.

Use your existing May model configuration. In PowerShell:

```powershell
$env:MAYBECODE_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
Set-Clipboard $env:MAYBECODE_CONTROL_TOKEN
pnpm maybecode --ui web --port 3940
```

Open the printed URL, choose **连接本地服务**, and paste the token. The clipboard
command above copies a credential; clear your clipboard when finished. Tokens
stay in page memory only. Reloading requires connecting again. `--continue` and
`--resume` retain their existing meaning. `--port` requires `--ui web`; `0`
requests an available port. The default TUI remains `retained`.

For MaybeClaw, run the following command. Missing configuration or administrator
authentication opens a local password setup page. Initialization preserves existing
May settings, saves a password hash, and opens the console at the same address.
Log in with the password you set, add an Agent, and create a session. With `--no-open`
or `serve`, open the local initialization HTML file printed by the terminal:

```powershell
pnpm maybeclaw
```

This starts the service and opens the default browser. You can add your first Agent
through **Agent 管理** -> **添加 Agent** in the Web interface and create sessions
without restarting the service. `--no-open` and the `serve` subcommand start only the
service; Ctrl+C stops it.

The service converts the password to a salted hash at startup or after a configuration
save. Password changes invalidate existing logins. See the [MaybeClaw guide](maybeclaw.md)
for password configuration, login lifetime, and remote CLI authentication.

`pnpm example:web-ui` starts an **offline fixture** on port 3941: scripted
responses, memory-only sessions and a no-side-effect approval tool. Its public
fixture token auto-connects only this example. It neither invokes a real model
nor executes the business tasks entered into its composer.

## MaybeCode commands and interactions

The composer uses the terminal's slash-command registry, argument completion and
execution functions. Arrow Up/Down selects a completion; Tab inserts it. Unknown
commands and invalid arguments are reported without submitting a model message.
Management-command output is held in page memory, separately from conversation history.
Ordinary messages cancel active execution and wait for cancellation before
starting the new request. `/steer <message>` saves additional input for the next
complete Step boundary, including tools and approvals. Pending messages run in
FIFO order; idle steering starts a Run. `/stop` and the cancel control cancel
active work and queued input. Cancelled input needs explicit resubmission.
Delivered steering text appears once in the conversation, including after
reopening the Session. History search and field details read the complete saved
text even when the snapshot preview is truncated.

| Operation | Web entry |
| --- | --- |
| Model and default profile | Model dropdown; `/model` selection and default actions; `/model profile --default` |
| Reasoning effort | Effort dropdown; `/effort`; `/effort default` restores configured options |
| Sessions | Sidebar selection and confirmed deletion; `/new`, `/resume [id]`; rename and deletion in the session selector |
| Retry, instructions and status | `/retry`, `/instructions`, `/status`, `/context` |
| Input during execution | Ordinary messages interrupt; `/steer <message>` waits for the Step; `/stop` cancels current and queued input |
| Goals | `/goal start`, `/goal status`, `/goal pause`, `/goal resume`, `/goal cancel` |
| Context management | `/compact [history-reference\|provider-native]` and the compact button |
| Skills | `/skills`, `/skills show name`, `/skills use name [task]` |
| MCP | `/mcp` and its catalog, resource, prompt, watch and task operations |
| Recovery | `/recovery`, `/recovery resolve id finding` |
| Display | `/details`, `/thinking`, transcript search, inspection and scrolling |
| Host exit | `/quit` or `/exit`, followed by confirmation |

MCP form and editable review windows display the request, accept JSON, preview the
exact submitted content and require confirmation. URL requests require consent,
manual navigation and a separate retry action. Interactions and cancellation can
be submitted while a command is awaiting a response. The broker validates schema,
request ownership and expiry, and responses remain outside conversation history.
Standalone `--ui web` enables the same interaction broker as the terminal.
The separate `team` and `mcp login` CLI subcommands keep their CLI entry points.

After building, set `MAYBECODE_WEB_LIVE=1` and run
`pnpm --filter @may/maybecode exec node --test test/integration/web-controls.test.mjs test/integration/web-terminal.test.mjs`.
These checks use the local model configuration, real workspace and MCP broker,
plus a real model task for tool approval and file creation. Test data stays under
the ignored `review` directory. The command performs model requests.

## Session forks and file versions

Hosts with a project workspace show the current Git branch in the conversation
header. Detached HEAD shows a short commit hash; initialization and read errors
have explicit states. Workspace information follows Session switches and external
Git changes. Historical replies retain their recorded branch and commit.

**创建分支** after a completed reply opens the workspace-mode dialog. The current
workspace preserves current files. A new worktree starts from the reply's recorded
commit. Missing recoverable Session state disables forking; missing file versions
disable worktree creation. In-progress messages are not selectable fork positions.

**本轮文件变化** displays a reply's version changes. **查看文件变化** in the header
offers Session-wide and current-workspace comparisons. The file list identifies
added, modified, deleted and binary files. Text diffs support scrolling, search and
change navigation. Uncommitted content is labeled as current workspace changes.
**预览恢复** reads the selected historical file content and displays the restoration
diff; **确认恢复文件** applies it. Manual changes after preview prevent restoration
and produce a conflict diagnostic.

**管理 worktree** lists registered directories, branches, starting commits and
states, with explicit open and delete actions. The host checks linked sessions,
processes, uncommitted changes and unmerged commits before deleting a directory.

In the MaybeCode TUI, `/fork` opens the history tree: Arrow Up/Down selects,
Left/Right expands or collapses, `/` searches, Space previews, Enter chooses the
position and workspace mode, and Escape cancels. `/changes` opens the file list;
Enter opens a diff, Page Up/Down scrolls, `/` searches, `N` finds the next match,
`]` advances to the next change, and Escape returns to the file list. The footer
displays the current branch.
In a reply's diff, `R` previews restoration of the selected file and `Y` explicitly
confirms it.

Shared components receive structured state through optional `workspace`,
`forkPoints`, `checkpoints` and `worktrees` snapshot fields. They send operations
through `session.fork`, `changes.view`, `worktree.open` and `worktree.delete`.
Controls remain hidden when the host does not provide the corresponding capability.
Restoration uses `changes.restore.preview` and `changes.restore.apply`.
`UiWorkspaceDiff.restorePreviewId` identifies the preview; the host retains the
actual content and conflict-check information.

After `pnpm build`, the workspace browser checks use the configured
`deepseek-v4-flash` profile when `MAY_LIVE_PROVIDER_UI_TESTS=1`. The Session fork
check also requires `MAY_GIT_CHECKPOINT_TEST_COMMITS=1`, which authorizes commits
inside its isolated test repository and worktrees. It makes actual provider
requests and checks reply forks, file restoration through WebUI and TUI, stale
previews, and fork rejection during a blocked Git checkpoint. Run
`node --test packages/ui/web/test/browser/workspace-versions.test.mjs packages/ui/web/test/browser/workspace-session-fork.test.mjs`.
Both checks are skipped without their required environment flags.

## Boundaries

`ApplicationUiHost` accepts an independent `events` stream and
`closeApplication: false` when a terminal owns the controller. The terminal must
distribute each event to both frontends and close the controller when it exits.
`startUiServer({ browserLogin: true, ... })` adds a one-time connection exchange
and returns `createLoginUrl()`. Pair it with `webUiAssets(..., { browserLogin: true })`.
Product servers composing additional API routes can import `BrowserLogin` from
`@may/ui-client/server` and use `issue()`, `redeem(ticket)`, and `clear()` with the
same one-time ticket semantics and existing origin checks.
Custom shells can provide `initialToken` and `connectionHint` to `mountWebUI`.
With `initialToken`, the connection dialog shows the launcher instructions and
omits manual token entry.

`ApplicationUiHost` supports product `controls`, `complete`, `available`, `submit`,
`concurrentCommands` and `interactionCommands` hooks. Awaiting a product command
does not hold the snapshot queue; interaction responses have their own guarded
path. Products must validate availability and request ownership when executing.
`UiReceipt.output` describes transient command output/actions; `disconnect` ends
the requesting client connection. `UiSnapshot.controls` advertises command input,
interaction responses and cancellation. `UiClient.interact()` can respond while
`command()` is pending. `startUiServer` accepts an `exit` callback after the exit
receipt is flushed and exposes `closed`; without a callback it closes its host.
`GET /api/ui/complete` is authenticated and bound to host and Session. Request
bodies are limited to 256 KiB and argument strings to 64 Ki characters; product
commands apply their own smaller limits where required.

| Layer | Ownership |
| --- | --- |
| Agent application / product host | Execution, permissions, budgets, persistence and recovery |
| `@may/ui-client` | JSON contracts and browser-safe connection/state logic |
| `@may/ui-client/application` | Adapter for one single-active-session workspace |
| `@may/ui-client/server` | Loopback HTTP, bearer authentication, origin checks, receipts and SSE invalidations |
| `@may/web-ui` | Optional shell, transcript, composer, approvals, detail panels and safe Markdown |
| Product extensions | Coding Diff, task lifecycle, delivery and other domain semantics |

Packages never import `apps`. Browser modules never import Node-only adapters,
TUI, providers, or live runtime objects. Native ES modules are served from a fixed
asset map, not arbitrary filesystem paths. The new projection is UI-neutral; the
existing TUI has not yet migrated to it.

Implement `UiHost` to connect another product, or use `ApplicationUiHost` with an
`AgentWorkspaceController`. Supply a product descriptor and optional commands,
choices and panels. Compose the exported Web components independently if the
default session/task shell does not fit. Trusted renderer extensions receive
client state and a command callback; unknown presentation kinds show text rather
than loading code. The protocol and extension API are versioned previews, not a
claim that every future agent will fit without an adapter.

Products can declare structured sidebar navigation via `WebUiOptions.navigation`
or compose navigation elements with `createNavigation()`. Each navigation group holds typed items with an icon,
label, optional title, optional badge, action callback, and optional disabled state. Supported icons
include `plus`, `menu`, `send`, `stop`, `panel`, `search`, `arrow`, `code`, `task`, `trash`, `gear`, `users`,
`message`, `check`, and `filter`. Products can also configure `WebUiOptions.onNew`
and `newLabel` to customize the primary creation action with typed lifecycles and unified error reporting.

On mobile viewports matching `max-width: 760px`, opening the
navigation drawer activates an overlay backdrop (`.mobile-backdrop`) that blocks clicks to the main content
without horizontal page overflow. While hidden, the mobile drawer sets `inert` and `aria-hidden="true"`.
Pressing Escape or clicking the backdrop dismisses the drawer and restores focus
to the invoking toggle button.
Tab and Shift+Tab cycle through the open mobile panel's controls. Native modal
dialogs retain their own keyboard handling.

## Protocol v1

- `GET /api/ui/snapshot?selected=<id>` returns product capabilities, resource
  summaries, selected resource, transcript, pending interactions, choices and panels.
- `GET /api/ui/events` is an authenticated fetch/SSE **invalidation** stream.
  It does not stream raw provider objects or promise durable event replay.
- `POST /api/ui/commands` accepts `{ version, hostId, requestId, name, targetId, expectedActiveId?, args }`.
  Arguments are bounded string fields; each adapter validates an explicit command allowlist.

Clients resnapshot on attachment, invalidation and reconnect. A two-second
heartbeat also observes changes made by CLI/channel owners. Live changes are
coalesced for 120 ms. Slow event connections are closed instead of buffering
unbounded data; clients reconnect with backoff. Old selection/request responses
cannot replace newer state. This deliberately favors correctness over a
high-throughput delta protocol.

Commands are not automatically retried. A host-local receipt cache returns the
same result for the same request ID and content, and rejects conflicting reuse.
At 4,096 receipts the host rejects new commands until a controlled restart; it
does not evict a receipt and risk executing it again. Every restart changes
`hostId`, so an uncertain old command is rejected. Inspect current state before
issuing a fresh request. This is **not** durable exactly-once execution.

## Product coverage

**MaybeCode:** submit messages, see incremental model/tool output, review tool
inputs and coding change previews, resolve tool approvals, cancel, list/new/open/
rename/delete sessions, switch model profiles and request context compaction.
The displayed session is the host's current session: `selectedId` equals `activeId`.
Clicking a sidebar session activates it so the composer can continue that session.
All connected pages follow session changes, including changes made in the TUI.
Switching, creating and deleting sessions are disabled during a run or pending MCP
interaction. Finish or cancel the current operation before changing sessions.

Inactive sidebar sessions show a trash icon on hover or keyboard focus; touch
devices keep the icon visible. Deletion requires confirmation. The current
session cannot be deleted, and the host rejects direct deletion requests for it.
The list and connected pages refresh after deletion. New-session,
activation and deletion commands carry `expectedActiveId`; stale transitions are
rejected without automatic replay. Commands remain bound to their `targetId`.
`UiClient.select(id)` sends `session.activate` for session hosts; snapshot reads
always return the current session. Upgrade this preview's client and host together.
Task hosts retain independent selection. History search and field reads remain
read-only operations within the workspace.

`AgentWorkspace.readSessionHistory(id)` validates workspace catalog membership
and uses optional `SessionStore.inspect(id)`. It never opens a runtime, changes
catalog recency, obtains execution ownership or repairs a log. The built-in file
store ignores incomplete trailing bytes without truncating them and still rejects
malformed complete records. Custom stores must implement safe inspection; there
is no fallback to a potentially repairing `read()` for workspace history browsing.

**MaybeClaw:** independent task submission, task-local browsing, live output from
tasks executed by this host, final results, cancellation intent, evidence recovery,
failed-dispatch retry, channels and the most recent 100 delivery records. Execution,
verification and delivery remain separate. Queued tasks still use host-selected
configuration and read scope; the UI cannot inject tools, paths or budgets. The
existing `/api/tasks` and `/api/health` routes remain compatible.

## Safety and current limits

- Local single-operator service only. Bind to `127.0.0.1`, not a public address.
  Do not expose it through a tunnel or treat its token as multi-user authorization.
- Tokens are never placed in URLs, browser storage or generated application assets.
  Closing a page stops only its connection; stopping the host closes the agent.
- Snapshot projection excludes provider continuation state. Tool inputs/results
  remain sensitive workspace data available to the authenticated operator.
- Snapshots return at most 50 recent blocks; older committed blocks are available
  through read-only pagination and search. Preview fields remain bounded to roughly
  64K characters. The inspector reads stored fields in 32,768-character chunks.
  Oversized approval inputs remain deny-only; reading details does not expand grants.
  File/artifact downloads are not implemented.
- Supported Markdown is a safe subset: paragraphs, headings, lists, quotes, code
  fences, tables, bold, inline code and HTTP(S) links. Raw HTML, remote images,
  generated JavaScript and executable artifact previews are not enabled.
- MaybeClaw now reads existing Session journals for historical tool calls/results,
  including after restart. Its bounded live projection still retains eight tasks;
  transient progress/partial token streams are not reconstructed from missing data.
  Reading does not add persistence, acquire an execution owner or run recovery.
- Full file browsing and artifact downloads are not provided. Recovery commands
  use the current execution owner. Open the Web workbench with `/web` to share a
  TUI Session; keep each Session owned by a single runtime.
- The current browser text is Chinese. Documentation is maintained in English and
  Chinese. Light/dark themes follow the OS; narrow screens use overlay side panels.

## Unified execution evidence

Shared tool cards distinguish waiting for approval, running, completed, failed,
denied, not-started and unknown outcomes. A cancelled run is not proof that tool
side effects were rolled back: a started call without a confirmed result is
unknown. Explicit host recovery records can report not-started. Partial assistant
answers are labelled interrupted. Errors retain bounded messages/codes, and tool
progress is live display data, not durable completion evidence.

Approval records inside tool cards are read-only. Only the host's current
`snapshot.interactions` produces decision controls, linked to block/run/call IDs.
Historical replay does not recreate actionable requests. Terminal or unavailable
execution removes live controls; stale or unavailable choices fail at the host.
A session-wide choice is shown only for requests with a grant key. Truncated
approval input is deny-only, including server-side validation.

Trusted products can register `tools[toolName]`, `approvalDetails[toolName]`,
`diagnostics[code]`, `presentations[kind][version]` and `panels[id]` callbacks in
`WebUiExtensions`. Callbacks return an HTMLElement or null. Tools, approval details
and diagnostics add content without replacing standard status labels, raw evidence
or approval buttons. Unsupported presentation kinds/versions, null results and
exceptions fall back safely. No module is loaded from model output. This preview
changes presentation registration from a callback per kind to callbacks per version;
upgrade product extensions alongside host/client packages. MaybeCode's Diff has
been migrated; evidence-bound pre-approval Diff is still separate work.

This change does not add MaybeClaw history persistence, new recovery commands,
TUI rendering changes or multi-session concurrency. MaybeClaw consumes the shared
tool projection; its task/verification/delivery policies remain product-owned.
`node examples/web-ui/states.mjs` provides a read-only synthetic state/extension
gallery on port 3944 after building. Type `stop` to shut it down. It exercises UI
fallbacks, not actual process crash recovery.

## Long conversations, inspection and history reads

The shared workbench groups records by host-provided run ID, with request text as
the heading where available. Tool counts, waiting approvals and exceptional states
are visible without expanding every call. Expand/collapse all and exception-only
filtering are view-local; approval controls remain outside these filters. A pinned
approval shortcut locates the current request. When reading older content, live
updates preserve the visible anchor and offer a new-content/back-to-latest button.
Transcript rendering evaluates block and interaction signatures to detect changes.

Tool transcripts contain labelled previews. **View details** opens an independent
side panel with overview/product renderers, input, output, error and presentation
fields. Long answers and diagnostics also have an inspection action. Read-only
field tabs provide previous/next chunks and an explicit refresh; the host hashes
field content and scope so changed data cannot be silently spliced across chunks.
The overview reuses the existing versioned Diff extension. Large presentation JSON
is available as raw text chunks, not a newly implemented large-Diff renderer.

The sidebar searches all session titles or task prompts and pages resources by
creation time (with a stable ID tie-breaker); the current selection may be pinned
in addition to the page. Resource additions, deletions and title changes refresh
the loaded sidebar pages while preserving the search query and number of loaded
pages. Hosts can provide `snapshot.resourcesVersion` for the complete catalog's
membership, pagination order and searchable text, including entries outside the
recent-resource window. Hosts without this field refresh when the resource IDs or
titles in the snapshot change. Within a resource, **Search content** searches committed
user/assistant text, reasoning, tool input/output, diagnostics and presentation
text, including text beyond preview limits. Results contain matching blocks, not
a complete run, and are read-only snapshots refreshed by searching again. Clear
search restores the recent timeline. Older pages are prepended without activating
a session or discarding current approvals. The UI reports counts for loaded data,
not a total count of runtime operations that were never recorded.

Custom hosts opt in through `snapshot.reads` and optional `UiHost.resources`,
`history` and `field` methods. The authenticated GET routes are `/api/ui/resources`,
`/api/ui/history` and `/api/ui/field`; all require the current `hostId`, and the last
two require `selected`. Page requests accept `query` and opaque `cursor`. Each page
contains at most 50 records with an approximately 256K-character payload budget
(one large bounded block may exceed that budget). Cursors bind host/resource/query
and an anchor, not authorization. Deleted anchors or changed scope fail closed;
restart the search after these errors. Metadata can change between pages. Client
read responses from an old host/selection are discarded independently of commands.

History uses safe `SessionStore.inspect`; MaybeClaw additionally validates task
ownership and existing journal evidence. No provider continuation state, permission
context, new tool execution or log-tail repair is exposed through reads. This
implementation scans the existing catalog/journal in memory: transport paging is
not a storage index, virtualized timeline or constant-memory database query. Very
large journals and many manually loaded pages still have CPU/memory costs.

After building, run `node examples/web-ui/reading.mjs` for a real shared-host,
in-memory fixture with 520 transcript blocks and 56 sessions. Prompts containing
`审批` produce a 90,006-character synthetic tool result; `慢速` exercises scrolling
while streaming. It uses no provider, files or real tools. Type `stop` to close it.

## Browser acceptance

`pnpm --filter @may/web-ui exec playwright install chromium` installs the browser
for `pnpm --filter @may/web-ui test:browser`. This automated test checks DOM text
and controls against the real workspace, session catalog, UI host and HTTP service.
It covers 520 sessions, additions, deletions outside the recent-resource window,
renames, retained pagination, search changes and expired cursors. It makes no model
requests and saves no screenshots. Temporary browser files stay under `review/`.

Reading-workbench acceptance used 520 transcript blocks, 56 browser-visible
sessions, and an API fixture with more than 500 catalog entries. It verified
paging/search beyond the snapshot, all three chunks of a 90,006-character tool
result, collapse/filter-safe approval access, the product Diff inspector and
persisted MaybeClaw tool results after a host restart. During streamed output,
the same visible history anchor kept its measured position; back-to-latest reached
the bottom. Shared controls/inspection also passed a 390 px layout check without
horizontal overflow. This was scripted offline acceptance, not a live-provider or
large-scale storage benchmark.

After `pnpm build`, run `node examples/web-ui/acceptance.mjs`. It starts both real
product hosts on loopback ports 3942/3943 with a scripted model, disabled channels
and newly created temporary files. Enter the printed public fixture token. Prompts
containing `审批`, `读取`, `慢速`, `长文` or `错误` exercise approval (MaybeCode),
reading, slow streaming, long output and simulated failure. Terminal commands
`restart` and `stop` restart the isolated hosts or shut them down; files remain
at the printed temporary path for inspection.

Browser acceptance on 2026-09-13 covered connection, Chinese text and newline
entry, streaming/cancellation, Markdown/code copy, sessions/models, approvals,
task browsing, refresh/reconnect and desktop/390 px layouts. This used mock model
responses, not live providers, actual Chinese IME composition, real mobile
keyboards, external channel delivery or crash-recovery fault injection.

Additional offline acceptance for unified states covered MaybeCode allow/deny,
cancellation while awaiting approval, error details, read-only history, and the
migrated Diff renderer. MaybeClaw covered completed read tools, retained partial
answers after cancellation and failed-task diagnostics. The synthetic gallery
covered throwing/unknown-version renderers and 390 px layout without horizontal
overflow. No live provider or process-crash recovery was used in this check.

### Live provider check

The subsequent 2026-09-13 check used the existing `gpt-5.6-luna` profile through
`openai-responses` and its configured local proxy, with isolated synthetic files
and no channels. Browser actions verified read → approval → edit → Diff,
continuation after cancellation, task results/cancellation, and persisted results
after a process restart. It made 9 provider requests: 7 completed and 2 cancelled;
completed requests reported 8,992 tokens (not a billing total). A separately
labelled pre-request failure tested error recovery without contacting the provider.
An empty assistant card for tool-call-only responses was fixed and rechecked
against the saved real session.

Reproduce only with explicit spending authorization:
`node examples/web-ui/live-acceptance.mjs --live`. The ceiling is 12 requests,
2,048 output tokens per request and 120 seconds per run; retries are disabled.
Use the public disposable token documented in the example README, then type
`stop` in the terminal after testing. `--resume <printed-temporary-directory>`
retains evidence and request counters across a process restart. This check does
not verify upstream model identity, an actual provider outage, external delivery,
mobile keyboards or crash-recovery behavior.

## Design references


The implementation uses a restrained sidebar, readable transcript, persistent
composer and optional detail panel. References inspected on 2026-09-13:

- [ChatGPT](https://chatgpt.com/): new-chat, search and history navigation.
- [Claude Projects and Artifacts](https://www.anthropic.com/news/projects): a
  separate work/output surface beside conversation.
- [Kimi](https://www.kimi.com/): conversation and task entry points.
- [Z.ai](https://chat.z.ai/): compact navigation, model selection and focused input.
- [Gemini Canvas](https://gemini.google/gp/overview/canvas/?hl=en): a separate
  work surface rather than forcing all content into chat bubbles.
- [DeepSeek](https://chat.deepseek.com/): the public entry required sign-in;
  its authenticated interface was not inspected or reproduced.

These are interaction references, not copied assets or claims that May implements
those products' search, uploads, scheduling, canvas or model capabilities.
