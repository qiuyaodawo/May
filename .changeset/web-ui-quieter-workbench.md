---
"@sortedyuan/web-ui": patch
"@sortedyuan/ui-client": patch
---

Simplify the Web workbench. The header no longer shows a resource-kind tag, the sidebar no longer shows the PREVIEW and LOCAL WORKSPACE labels, and the empty state shows only the product subtitle and suggestions. The composer no longer shows a mode label. Assistant replies no longer carry a "May" label, and approval cards no longer carry an eyebrow label. The reading toolbar hides its tool controls when there are no tool calls and hides itself when it has nothing to show. History search appears only when the transcript has content, and the clear-search button appears only during an active search. The sidebar shows the loaded count only while more records remain. The selected resource, approval card, buttons and composer use neutral colors without shadows or backdrop blur, font sizes are limited to 12, 14, 16 and 22 px, and the unused `--shadow` custom property is removed. Icons come from Lucide: `@sortedyuan/web-ui` now depends on `lucide` and serves the icon module at `/webui/icons.js` with Lucide's element factory under `/webui/lucide/`. The mobile sidebar close button and the tool card expand marker use Lucide icons instead of text characters.

`ApplicationUiHost` snapshots include `notice` only when the host reports a fault; the default guidance text is removed.
