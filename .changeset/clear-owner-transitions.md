---
"@sortedyuan/session": patch
"@sortedyuan/application": patch
"@sortedyuan/config": patch
"@sortedyuan/coordination": patch
"@sortedyuan/maybecode": patch
---

Coordinate writer-lock creation and deletion with permanent access markers across processes, covering coordination journals, resource journals, remote workers, configuration updates, Team verification and patch application. Preserve owner files after process termination and close owned handles when release cannot obtain file access. Upgrade all processes sharing a data directory together and retain the access markers during recovery.

Serialize Git workspace lock metadata publication, recovery and release. Report incomplete owner metadata as GitWorkspaceConflictError and let concurrent close calls await the same release.
