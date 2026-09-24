# @may/web-ui

`WebUiOptions.authentication` accepts a product-owned `{ label, login, logout }`
implementation. `login(password)` returns a temporary UiClient Bearer credential;
`logout()` revokes it when the user disconnects. Password input preserves spaces
and clears after submission. Set `connectionHint` to explain the product's login.
This option cannot be combined with `initialToken`.

The workbench displays optional `UiSnapshot.badges` in its fixed header,
including on narrow screens. Badge labels and tones come from the host and update
with snapshots, independently of transcript scrolling and detail panels.

Ordered image content supports authenticated viewing, original-image links and
downloads. See [Image replies](../../../docs/en/guides/images.md) /
[图片回复](../../../docs/zh-CN/guides/images.md).

A new browser workbench, not an extraction of MaybeClaw's old page. No React,
terminal renderer, CDN, browser runtime compiler, or product import is required.
The browser entry exports `mountWebUI`, `transcriptBlock`, `approvalCard`,
`detailPanel`, `markdown`, `createNavigation`, and the trusted extension interfaces.

```ts
import { UiClient } from "@may/ui-client";
import { mountWebUI, type WebUiNavigation } from "@may/web-ui";

const navigation: WebUiNavigation = {
  groups: [
    {
      title: "Operations",
      items: [
        {
          id: "manage",
          label: "Settings",
          icon: "gear",
          action: () => openSettings(),
        },
      ],
    },
  ],
};

const client = new UiClient();
const dispose = mountWebUI(root, client, {
  title: "My Agent",
  kind: "session",
  navigation,
  onNew: () => startFreshSession(),
});
await client.connect(controlToken);
// dispose() disconnects this view, not the agent host.
```

Use your bundler for imports above, or `webUiAssets()` from `@may/web-ui/assets`
to serve the bundled native-ES-module shell and CSS through the loopback host.
Import `@may/web-ui/styles.css` when composing components outside that shell.

`webUiAssets(..., { browserLogin: true })` supports the loopback server's one-time
connection links. The page removes the ticket fragment before exchange and keeps
the returned token in memory. Custom shells can pass an `initialToken` promise
and a `connectionHint` to `mountWebUI`. With `initialToken`, the connection dialog
shows the launcher instructions and omits manual token entry. Disposing the shell
prevents a pending promise from connecting a closed view.

When a product supplies `UiSnapshot.controls`, the composer offers slash-command
completion and displays `UiReceipt.output` with guarded actions and confirmation
dialogs. Completion uses Arrow Up/Down and Tab. Product interactions support JSON
forms, editable reviews and explicit URL consent. Drafts survive snapshot updates;
completed requests remove their controls. Preview and confirmation precede sending
form content, and responses remain possible while a command is pending.

Products can register tool, approval-detail, diagnostic, presentation and panel renderers. Each receives its DTO and an
optional context containing client state and the guarded `command` method. A
trusted product extension module can be included by `webUiAssets`; no module is
ever loaded from an agent message. Unknown presentation kinds/versions, null returns and thrown renderer errors fall back to the default view.
MaybeCode demonstrates a product-owned Diff renderer.

Markdown supports paragraphs, headings, lists, quotes, code fences, tables,
inline code, bold and HTTP(S) links. HTML, remote media and generated JavaScript
are never executed. This is not a complete CommonMark implementation.

See the [English guide](../../../docs/en/guides/web-ui.md),
[简体中文指南](../../../docs/zh-CN/guides/web-ui.md), and
[offline example](../../../examples/web-ui/README.md).

## Execution evidence and extensions

`UiBlockStatus` distinguishes waiting for approval, running, completed, failed,
denied, not-started, interrupted, cancelled and unknown outcomes. Tool cards retain
raw input/output, error codes, approval evidence and run/call IDs. Partial assistant
responses are marked interrupted. Unknown outcomes never offer an automatic retry.
Only `snapshot.interactions` contains current approvals; transcript approval
records are read-only. The host still validates every choice.

```ts
const extensions: WebUiExtensions = {
  tools: { "my.tool": block => renderToolSummary(block) },
  approvalDetails: { "my.tool": request => renderApprovalExplanation(request) },
  diagnostics: { "MY_ERROR": diagnostic => renderHelp(diagnostic) },
  presentations: { "my.preview": { 1: block => renderPreview(block) } },
};
```

These trusted callbacks return an `HTMLElement` or `null`. Tool, approval and
error extensions supplement the default evidence; they do not replace status
labels, raw inputs/errors or the shell-owned approval choices. Presentation
renderers are selected by **kind and version**. This preview changes the old
`presentations[kind]` callback to `presentations[kind][version]`; update product
extensions with the host and browser packages. MaybeCode's Diff uses version 1.
Approval details do not by themselves implement evidence-bound pre-approval Diff.

Run `node examples/web-ui/states.mjs` from the repository root after building to
inspect a read-only synthetic gallery, including failed renderers and unsupported
presentation versions. Use `stop` to close it. It is not runtime recovery evidence.


## Typed navigation and product extension

Products configure custom sidebar navigation via `WebUiOptions.navigation` or
compose standalone navigation elements with `createNavigation(navigation, getContext)`.
Navigation declarations define groups containing typed items with an icon,
label, optional title, optional badge, action callback, and optional disabled predicates. Supported icons
include `"plus"`, `"menu"`, `"send"`, `"stop"`, `"panel"`, `"search"`, `"arrow"`, `"code"`, `"task"`, `"trash"`, `"gear"`, `"users"`, `"message"`, `"check"`, and `"filter"`. Custom creation actions use `WebUiOptions.onNew`
and `newLabel`, replacing internal DOM event interception with typed lifecycles and unified error reporting.

```ts
export interface WebUiNavigationItem {
  readonly id: string;
  readonly label: string;
  readonly title?: string;
  readonly badge?: string;
  readonly icon?: "plus" | "menu" | "send" | "stop" | "panel" | "search" | "arrow" | "code" | "task" | "trash" | "gear" | "users" | "message" | "check" | "filter";
  readonly ariaLabel?: string;
  readonly disabled?: boolean | ((state: UiClientState) => boolean);
  action(context: WebUiContext): void | Promise<void>;
}

export interface WebUiNavigationGroup {
  readonly id?: string;
  readonly title?: string;
  readonly items: readonly WebUiNavigationItem[];
}

export interface WebUiNavigation {
  readonly groups?: readonly WebUiNavigationGroup[];
  render?(container: HTMLElement, context: WebUiContext): WebUiNavigationLifecycle | (() => void) | void;
}
```

The shell renders navigation within an accessible navigation container (`<nav class="sidebar-navigation">`).
On mobile viewports matching `max-width: 760px`, opening the drawer sidebar activates
an accessible backdrop overlay (`.mobile-backdrop`) that blocks interaction with the main content.
When collapsed or hidden on mobile screens, the drawer applies `inert` and `aria-hidden="true"`
so child controls remain inaccessible to keyboard Tab navigation. Pressing the Escape key or clicking
the backdrop dismisses the drawer, cleans up overlay state, and restores keyboard focus to the invoking trigger.

## Reading workbench

The shell groups transcript records by run, retains local collapse/filter state,
keeps current approvals outside filters, and preserves the visible scroll anchor
while new output arrives. During continuous follow mode (`following: true`), the
reading container skips geometry measurements used to preserve the visible anchor.
Transcript rendering evaluates block and interaction signatures to detect changes,
and scroll animation frames are released during teardown or rapid stream updates.
Its toolbar offers counts, expand/collapse all, exception-only filtering,
approval location and back-to-latest/new-content controls.
Tool cards use short labelled previews; the independent inspector reuses trusted
product renderers and reads full stored fields in version-bound chunks. Long
answers and diagnostics also expose inspection. The inspector resets on host or
resource changes. Session selection switches the workspace's current session,
and all connected pages follow it. History search and field reads remain read-only.

The sidebar pages/searches all resource titles (task prompts for task hosts), while
content search and older-record loading use the selected host's read-only APIs.
Resource additions, deletions and title changes refresh the loaded sidebar pages
while preserving the search query and number of loaded pages. Hosts publish an
optional `snapshot.resourcesVersion` for their complete resource catalog; it covers
membership, pagination order and searchable text, including entries outside the
snapshot's recent-resource window.
Inactive session rows expose a confirmed delete action through a trash icon on
hover or keyboard focus; touch devices keep the icon visible. The current session
cannot be deleted. Session selection and deletion require an idle host with no
pending MCP interaction.
Search results are query snapshots, not live replacement approvals. Hosts without
read capabilities retain their basic snapshot UI; field tabs stay disabled.
Run `node examples/web-ui/reading.mjs` after building for a large offline fixture.

Run `pnpm --filter @may/web-ui exec playwright install chromium`, then
`pnpm --filter @may/web-ui test:browser` for Chromium DOM checks against the real
workspace, catalog, UI host and HTTP service. The test creates 520 sessions and
checks additions, deletions, renames, pagination and search. It makes no model
requests and saves no screenshots. Temporary browser files stay under `review/`.
