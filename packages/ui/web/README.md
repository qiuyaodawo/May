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

Products can register presentation/panel renderers. Each receives its DTO and an
optional context containing client state and the guarded `command` method. A
trusted product extension module can be included by `webUiAssets`; no module is
ever loaded from an agent message. Unknown presentations fall back to bounded text.
MaybeCode demonstrates a product-owned Diff renderer.

Markdown supports paragraphs, headings, lists, quotes, code fences, tables,
inline code, bold and HTTP(S) links. HTML, remote media and generated JavaScript
are never executed. This is not a complete CommonMark implementation.

See the [English guide](../../../docs/en/guides/web-ui.md),
[简体中文指南](../../../docs/zh-CN/guides/web-ui.md), and
[offline example](../../../examples/web-ui/README.md).
