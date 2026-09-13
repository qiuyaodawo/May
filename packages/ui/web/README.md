# @may/web-ui

A new browser workbench, not an extraction of MaybeClaw's old page. No React,
terminal renderer, CDN, browser runtime compiler, or product import is required.
The browser entry exports `mountWebUI`, `transcriptBlock`, `approvalCard`,
`detailPanel`, `markdown`, and the trusted extension interfaces.

```ts
import { UiClient } from "@may/ui-client";
import { mountWebUI } from "@may/web-ui";

const client = new UiClient();
const dispose = mountWebUI(root, client, { title: "My Agent", kind: "session" });
await client.connect(controlToken);
// dispose() disconnects this view, not the agent host.
```

Use your bundler for imports above, or `webUiAssets()` from `@may/web-ui/assets`
to serve the bundled native-ES-module shell and CSS through the loopback host.
Import `@may/web-ui/styles.css` when composing components outside that shell.

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
