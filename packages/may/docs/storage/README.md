# @sortedyuan/may/storage

**English** | [简体中文](README.zh-CN.md)

Local file coordination for Node.js 22.16.0 and later. Import this entry for
shared files, writer ownership and journal replacement.
The native dependency `fs-native-extensions` provides operating-system locks.

`withFileAccess(path, mode, action, options?)` accepts `"shared"` for readers and
`"exclusive"` for writers. It returns the awaited action's value and releases
access when the action settles. Every participating process must use the same
file path. Close data handles inside the action. Recursive access to the same
file fails with `FILE_ACCESS_REENTRANT`.

Options are `timeoutMs` (30000 by default), `signal`, and `initialize` (true by
default). Initial access creates persistent `.access` and `.access.gate` files
beside the data; preserve them while any process uses the data. With
`initialize: false`, missing markers fail with `FILE_ACCESS_NOT_INITIALIZED`.
Timeout and cancellation stop lock acquisition. An action already running keeps
ownership until it settles. Process termination releases native locks.

`acquireFileLock(path)` takes an exclusive operating-system lock on `path` and
returns a `FileLock`. Another owner makes acquisition fail immediately with
`ELOCKED`, and the error includes the process ID and host name saved in
`<path>.owner`. The operating system releases the lock when the owner exits.
`lock.assertHeld()` rejects when `path` no longer refers to the locked file, and
`lock.release()` releases it. `acquireFileLockSync(path)` provides the same lock
for synchronous storage.

`writeFileDurable(path, contents, mode?)` atomically replaces a file through
`write-file-atomic` and syncs its directory. `hasErrorCode(error, code)` checks a
Node.js error code.

`replaceJournalFile(path, contents)` writes and syncs a temporary file, replaces
the destination under exclusive access, syncs its directory and returns an open
append handle. Its caller owns the journal's writer lock and closes the returned
handle. `syncDirectory(path)` syncs directory metadata on POSIX; Windows returns
without a directory sync because Node.js provides no POSIX directory fsync there.
An error after replacement requires the caller to inspect the persisted outcome.

Session's `file-access` and `file-store` subpaths reexport these same functions.
Both import paths share reentrant-access detection and lock ownership behavior.
See the [storage guide](../../../../docs/en/guides/custom-storage.md#coordinate-local-file-access)
for a runnable example and storage maintenance procedures.

Run `pnpm --filter @sortedyuan/may test` for native multi-process access,
atomic replacement, timeout and cancellation checks.
