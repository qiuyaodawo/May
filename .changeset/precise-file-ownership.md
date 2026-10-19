---
"@sortedyuan/permissions": patch
---

Preserve full file identifier precision when checking rule file and writer lock ownership, including large Windows file identifiers. Reject access after lock replacement and preserve the replacement lock on close.
