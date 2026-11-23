---
"@sortedyuan/may": minor
"@sortedyuan/maybecode": patch
"@sortedyuan/coding-tools": patch
"@sortedyuan/coordination": patch
"@sortedyuan/providers": patch
---

Harden core runtime, config locking, workspace containment, shared budget, and provider retry guardrails:

- `@sortedyuan/may`: export `resolveMayConfigTargetPath` (`@experimental`) and use it in `loadMayConfig` and `updateDefaultMayModel` so symlinked or aliased config paths share the same lock, atomic target, and directory sync; expose `MayConfigWriteError.replaced` so callers can distinguish post-rename directory sync failures; use a monotonic clock (`performance.now()`) in `RunBudgetMeter` so wall-clock adjustments cannot prematurely trigger `durationMs` exhaustion; break the `core/may.ts` ↔ `core/runtime.ts` runtime circular import; use shared durable writes in `FileSessionCatalog`.
- `@sortedyuan/maybecode`: when `setDefaultModel()` receives a post-rename directory sync error (`MayConfigWriteError.replaced === true`), update in-memory default model state and emit `model.default.changed` so the UI reflects the already-written config while still reporting the storage sync error.
- `@sortedyuan/coding-tools`: reject dangling intermediate symbolic links in `resolveWritableWorkspacePath`; normalize absolute paths under a non-canonical/symlinked workspace `cwd` before containment checks; bound POSIX/Windows host process group termination, macOS `/bin/ps` probes, and post-exit host pipe closure with hard timeouts.
- `@sortedyuan/coordination`: clear settled accounting fields (`estimated`, `exceededReservation`, `usage`, `cost`, `reconciliation`) when `FileSharedBudget` transitions a call to `unknown` or re-settles it, preventing `Invalid shared budget estimate` journal validation failures.
- `@sortedyuan/providers`: chunk built-in `RetryingModel` sleep timers at `2_147_483_647` ms so delays exceeding the 32-bit Node.js timer limit never overflow to 1 ms while keeping custom `sleep` hooks and config schemas compatible.
