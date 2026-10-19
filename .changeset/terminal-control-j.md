---
"@sortedyuan/tui": patch
---

`NodeTerminalDriver` 将独立 LF 输入识别为 `Ctrl+J`，支持应用绑定换行操作。
CR 输入继续识别为 `Enter`，bracketed paste 中的换行保留为粘贴文字。
