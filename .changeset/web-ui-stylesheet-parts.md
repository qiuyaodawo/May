---
"@sortedyuan/web-ui": patch
---

Split the workbench stylesheet into section files. `@sortedyuan/web-ui/styles.css` now loads them with CSS `@import`, so bundlers and servers that read this entry must resolve the sibling files in the package's `assets` directory. The `/app.css` asset served by `@sortedyuan/web-ui/assets` remains one concatenated stylesheet with the same effective styles.
