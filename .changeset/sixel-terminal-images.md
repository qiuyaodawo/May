---
"@may/tui": minor
---

Support Sixel image previews in retained and readline terminals, including
Windows Terminal capability and cell-size queries. Resize previews to the
available cells, preserve text input while processing terminal reports, and
clear or redraw images when their viewport changes. Export TerminalImageSupport
and cell-size options for reusable terminal integrations. Add Sixel encoding,
image resizing, image-q palette generation and ANSI response parsing dependencies. Preserve pixel positions
and cached source data by encoding an independent pixel buffer.
