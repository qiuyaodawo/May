After completing a coherent feature, fix, or other meaningful change, run focused verification and commit it promptly; do not leave finished work uncommitted unless the user asks otherwise.

After completing a new feature, update affected documentation when necessary, including every maintained language version.

Keep tests and checks minimal. Run the smallest focused verification that covers the changed behavior, normally once after the change is ready. Add tests only for meaningful behavior or regression risks; avoid redundant cases and implementation-mirroring tests. Do not routinely run full-suite, coverage, path-alias, or packaging checks. Broaden or repeat verification only when explicitly requested or when a concrete failure or unresolved risk requires it. For documentation-only changes, review the diff without running code tests.
