# @sortedyuan/mcp

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
