---
"@sortedyuan/config": minor
"@sortedyuan/application": minor
"@sortedyuan/media": minor
---

Coordinate configuration loading and updates, Git checkpoint metadata access, and image verification and replacement across local processes. Concurrent readers no longer prevent these writers from replacing files on Windows.

**Breaking:** these operations use persistent `.access` and `.access.gate` files beside their data, backed by native operating-system locks from `@sortedyuan/session/file-access`. First access needs directory write permission to create the access files. Keep the files with the data and upgrade all processes sharing that data together. Initialize configuration with `loadMayConfig()` and existing images with `FileMediaStore.verify()` before granting only read permission. For strictly read-only Git metadata access, call `checkpoints()` and `listWorktrees()` once using a manager with `autoCommit: false` and `readOnly: false`; subsequent `readOnly: true` queries require only read permission and create no state files.
