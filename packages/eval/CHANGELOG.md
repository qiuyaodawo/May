# @sortedyuan/eval

## 0.2.0

### Minor Changes

- 738144a: Add repeatable Agent evaluation experiments with versioned component registries, independently prepared environments, bounded execution and cleanup, durable trial records, independent evaluators, human grading revisions, evidence retention controls, and configuration comparisons. Public Application and Coordination adapters reuse May execution, telemetry, pricing, permissions, and diagnostics. The private CLI validates trusted suites, runs or resumes experiments, grades trials, and exports reports.
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

- Updated dependencies [0dc3f68]
- Updated dependencies [0dc3f68]
- Updated dependencies [88e7d69]
- Updated dependencies [1e9bdfc]
- Updated dependencies [8df2b63]
- Updated dependencies [02789c6]
- Updated dependencies [c8c14c7]
- Updated dependencies [78bde1d]
- Updated dependencies [02789c6]
- Updated dependencies [8df2b63]
- Updated dependencies [2a44905]
- Updated dependencies [422e404]
- Updated dependencies [e3736f6]
- Updated dependencies [88e7d69]
- Updated dependencies [88e7d69]
- Updated dependencies [5d3b04a]
- Updated dependencies [0dc3f68]
- Updated dependencies [89bcd8d]
- Updated dependencies [78bde1d]
- Updated dependencies [89bcd8d]
- Updated dependencies [c8c14c7]
- Updated dependencies [63f68e5]
- Updated dependencies [88e7d69]
  - @sortedyuan/application@0.2.0
  - @sortedyuan/coordination@0.2.0
  - @sortedyuan/core@0.2.0
  - @sortedyuan/observability@0.2.0
  - @sortedyuan/permissions@0.2.0
