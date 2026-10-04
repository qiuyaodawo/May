---
"@may/coding-tools": minor
---

Breaking change: coding tools execute directly on the host. The `environment` option and the `environmentId` and `platform` fields on `WorkspacePath` have been removed. Configure tools with a host workspace `cwd` and select the shell executable through `ShellProfile`. Applications requiring execution isolation must provide it outside the coding tools.
