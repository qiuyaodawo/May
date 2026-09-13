# Shared Web UI

**English** | [简体中文](../../zh-CN/guides/web-ui.md)

This is the first developer-preview slice of a shared UI boundary. MaybeCode and
MaybeClaw use the same browser components and transport, but retain different
resource models. The old MaybeClaw page has been replaced, not extracted into a
library. Existing terminal frontends are unchanged.

## Run

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

MaybeClaw continues to use its existing command and token:

```powershell
$env:MAYBECLAW_CONTROL_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
Set-Clipboard $env:MAYBECLAW_CONTROL_TOKEN
pnpm maybeclaw serve
```

`pnpm example:web-ui` starts an **offline fixture** on port 3941: scripted
responses, memory-only sessions and a no-side-effect approval tool. Its public
fixture token auto-connects only this example. It neither invokes a real model
nor executes the business tasks entered into its composer.

## Boundaries

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

## Protocol v1

- `GET /api/ui/snapshot?selected=<id>` returns product capabilities, resource
  summaries, selected resource, transcript, pending interactions, choices and panels.
- `GET /api/ui/events` is an authenticated fetch/SSE **invalidation** stream.
  It does not stream raw provider objects or promise durable event replay.
- `POST /api/ui/commands` accepts `{ version, hostId, requestId, name, targetId, args }`.
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
rename sessions, switch model profiles and request context compaction. One host
has one active session shared by all windows. Session switches are idle-only;
commands bound to a stale session are rejected. Viewing another session currently
requires explicitly activating it, not independent per-window runtime selection.

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
- Display is bounded to 500 recent transcript blocks and roughly 64 KiB per text
  field. Oversized approval inputs offer denial only in the UI. Full-history
  pagination and large-artifact retrieval are not implemented.
- Supported Markdown is a safe subset: paragraphs, headings, lists, quotes, code
  fences, tables, bold, inline code and HTTP(S) links. Raw HTML, remote images,
  generated JavaScript and executable artifact previews are not enabled.
- MaybeClaw retains tool cards after completion for up to eight tasks in host memory. After restart, historical
  tasks show their final persisted result, not a reconstructed token stream. Tasks
  run by a different process have status/final-result visibility, not live deltas.
- MaybeCode team controls, interactive MCP forms/sampling, skill pickers, full file
  browsing, artifact downloads and recovery resolution have not yet been connected.
  Web mode does not opt into interactive MCP callbacks. Use existing terminal/CLI
  controls for these features; the Web shell does not advertise them.
  For session recovery, stop the Web host before resuming that session in the TUI.
  Do not open the same session in two independent runtimes.
- The current browser text is Chinese. Documentation is maintained in English and
  Chinese. Light/dark themes follow the OS; narrow screens use overlay side panels.

## Browser acceptance

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
