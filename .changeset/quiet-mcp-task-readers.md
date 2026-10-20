---
"@sortedyuan/mcp": patch
---

Coordinate MCP task journal reads with updates across journal instances and processes. Coordinate all encrypted credential record reads, replacements and deletions through the Session file-access helper, including concurrent OAuth status checks and token updates on Windows.

The credential store creates permanent `.access` and `.access.gate` files beside encrypted records. Upgrade all processes sharing a vault together and preserve these files while the vault is in use.
