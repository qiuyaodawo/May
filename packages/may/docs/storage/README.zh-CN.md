# @sortedyuan/may/storage

[English](README.md) | **简体中文**

为 Node.js 22.16.0 及后续版本提供本地文件协调。共享文件、写入权管理和日志替换
可以直接导入这个入口。原生依赖 `fs-native-extensions` 提供操作系统文件锁。

`withFileAccess(path, mode, action, options?)` 接受读取模式 `"shared"` 和写入模式
`"exclusive"`。函数等待 action 完成，返回其结果，并释放访问锁。所有参与进程使用
相同文件路径，数据句柄在 action 中关闭。递归访问相同文件会触发
`FILE_ACCESS_REENTRANT`。

options 包含 `timeoutMs`（默认 30000）、`signal` 和 `initialize`（默认 true）。
首次访问在数据旁创建持久的 `.access` 和 `.access.gate` 文件；进程使用数据期间
保留这些文件。`initialize: false` 要求文件已经存在，缺失时触发
`FILE_ACCESS_NOT_INITIALIZED`。超时和取消会终止获取访问锁；已经执行的 action
保持访问权直到结束。进程终止会释放原生文件锁。

`acquireFileLock(path)` 对 `path` 获取操作系统提供的排他锁，并返回 `FileLock`。
已有其他所有者时，获取立即以 `ELOCKED` 失败，错误信息包含 `<path>.owner` 中保存的
进程 ID 和主机名。所有者进程退出时，操作系统自动释放锁。`path` 不再指向已锁定的
文件时，`lock.assertHeld()` 拒绝；`lock.release()` 释放锁。`acquireFileLockSync(path)`
为同步存储提供同一种锁。

`writeFileDurable(path, contents, mode?)` 通过 `write-file-atomic` 原子替换文件并同步
所在目录。`hasErrorCode(error, code)` 检查 Node.js 错误码。

`replaceJournalFile(path, contents)` 写入并同步临时文件，在独占访问期间替换目标，
同步所在目录，随后返回打开的追加句柄。调用方负责持有日志写入锁并关闭返回的句柄。
`syncDirectory(path)` 在 POSIX 同步目录元数据；Windows 直接返回，因为 Node.js
在 Windows 没有提供 POSIX directory fsync。替换完成后发生错误时，调用方需要
检查已经保存的结果。

Session 的 `file-access` 和 `file-store` 子路径导出相同函数。两种导入路径共享
递归访问检查和所有权行为。可运行示例与维护步骤见
[存储指南](../../../../docs/zh-CN/guides/custom-storage.md#协调本地文件访问)。

执行 `pnpm --filter @sortedyuan/may test` 验证原生多进程访问、原子替换、
超时和取消。
