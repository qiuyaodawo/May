---
"@may/tui": minor
---

新增 `renderMarkdownExcerpt`，将 Markdown 转换为保留标题文字、列表、代码和链接的纯文本节选，支持可见字符数量与逻辑行数限制，并使用完整的 Unicode 字符和省略号表示截断。MaybeCode 的任务结果通知和 `/delegations` 查询统一使用此格式。
