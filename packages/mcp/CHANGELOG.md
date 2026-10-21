# @sortedyuan/mcp

## 0.2.3

### Patch Changes

- Updated dependencies
  - @sortedyuan/session@0.5.0

## 0.2.2

### Patch Changes

- 941b411: Coordinate the complete credential lock lifecycle across processes so Windows pending-delete handles cannot interrupt concurrent credential operations. Preserve the existing lock recovery procedure and ten-second acquisition limit.
- Updated dependencies [941b411]
  - @sortedyuan/session@0.4.0

## 0.2.1

### Patch Changes

- 749fadc: Coordinate MCP task journal reads with updates across journal instances and processes. Coordinate all encrypted credential record reads, replacements and deletions through the Session file-access helper, including concurrent OAuth status checks and token updates on Windows.

  The credential store creates permanent `.access` and `.access.gate` files beside encrypted records. Upgrade all processes sharing a vault together and preserve these files while the vault is in use.
- Updated dependencies [749fadc]
  - @sortedyuan/session@0.3.0

## 0.2.0

### Minor Changes

- 63f68e5: Breaking change: package names use the `@sortedyuan` npm scope. Update dependency
  names, imports, pnpm filters, and configured module specifiers from `@may/` to
  `@sortedyuan/`, then reinstall dependencies. MaybeCode provides the `maybecode`
  command and its headless API through `@sortedyuan/maybecode`.

  Plugin IDs, saved Session data, configuration locations, and the Anthropic message
  state format retain their existing identities. OpenTelemetry instrumentation
  uses `@sortedyuan/observability`; update filters that select instrumentation by name.

  The TUI package includes the PNG declarations required by its image dependency,
  so consumers can type-check installed declarations with `skipLibCheck: false`.

### Patch Changes

- Updated dependencies [02789c6]
- Updated dependencies [422e404]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [0dc3f68]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/core@0.2.0
