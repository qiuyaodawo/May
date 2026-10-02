# 执行环境

[English](../../en/reference/environment.md) | **简体中文**

`@may/environment` 为文件、进程和产物提供统一访问接口。工作区表示任务文件所在的
目录；环境提供访问这些文件时使用的系统身份、权限配置、程序、限制和生命周期。
宿主选择并管理环境，coding tools 使用这个环境实例。

## 本地配置

`createLandstripEnvironment()` 通过 landstrip 的 AppContainer runtime 支持 Windows。
`@landstrip/landstrip-api` 提供所需的 native 程序。工作区目录需要已经存在。
创建时检查 runtime、权限配置、必需程序和真实的二进制文件操作。
任何检查失败都会拒绝创建并释放环境资源。

```ts
import {
  createLandstripEnvironment,
  createArtifactReference,
  renderEnvironmentInstructions,
} from "@may/environment";
import { createCodingTools, createPowerShellProfile } from "@may/coding-tools";

const environment = await createLandstripEnvironment({
  workspace: process.cwd(),
  requiredPrograms: [{ program: "node", expectedOutput: "v" }],
  network: "none",
});
try {
  const description = await environment.describe();
  const tools = createCodingTools({
    cwd: description.workingDirectory,
    environment,
    shell: { profile: createPowerShellProfile({ executable: "powershell.exe" }) },
  });
  const instructions = renderEnvironmentInstructions(description);
  // 将 tools 和 instructions 提供给应用已有的 Agent 组合。
  await environment.writeFile("result.bin", new Uint8Array([0, 128, 255]));
  const reference = createArtifactReference(environment.environmentId, "result.bin");
  await environment.exportArtifact(reference, absoluteHostDestination);
} finally {
  await environment.close();
}
```

| 配置 | 行为 |
| --- | --- |
| `workspace` | 文件操作使用的宿主目录，也是命令默认工作目录 |
| `readablePaths` | 额外授予读取权限的已有路径 |
| `writablePaths` | 可写的已有目录，默认包含工作区，配置时必须包含工作区 |
| `deniedReadPaths`、`deniedWritePaths` | native 权限配置明确拒绝访问的已有路径 |
| `environment` | 明确提供的程序环境变量 |
| `requiredPrograms` | 创建时验证的程序、参数和预期输出 |
| `network` | 默认 `none`；`allow` 授予网络能力，访问仍受宿主配置限制 |
| `appContainerMode` | 默认 `standard`；`lpac` 请求受限 package access，必须通过启动检查 |
| `limits` | 进程并发数量、输出字节数、进程超时和文件字节数限制 |
| `signal` | 创建过程的取消信号 |
| `displayName` | 提供给宿主和 Agent 的环境名称 |
| `binary` | 宿主管理的 native landstrip 程序，默认使用依赖提供的程序 |

默认限制为最多同时运行 16 个隔离进程、每个输出通道保留 1 MiB、每个进程运行
120 秒、每个文件最多 16 MiB。文件操作也启动隔离进程，共享并发数量和超时限制。
当前没有 CPU 和内存配额。输出事件包含原始字节与增量解码的 UTF-8 文本；结果分别
报告保留的字节、实际输出字节数和截断状态。

环境只继承指定的 Windows 启动变量。PATH 包含受保护的 Node runtime 和 Windows
命令目录。额外程序需要合适的读取权限，以及明确的 PATH 或可执行程序路径，使用
`requiredPrograms` 验证它们。宿主凭据和其他环境变量需要明确配置。
`describe()` 报告能力、已验证程序、限制、隔离范围和资源归属，不包含环境变量值。

## 隔离与生命周期

每个文件 helper、命令及其后代都受到 AppContainer 限制。写入权限授予配置中的目录。
standard 模式也允许读取 Windows AppContainer 可以访问的资源，包括部分系统公共
文件，以及部分祖先目录的目录项。该模式报告的 `readScope` 为 `platform-default`。
LPAC 请求按允许目录清单限制读取；是否可用取决于指定程序和 Windows 安装情况，
创建时会进行验证。

文件接口接受工作区内路径，拒绝解析到工作区外的链接。递归目录查询报告链接，
不会进入链接目标。命令遵循 native 权限配置，可以访问额外授权的目录。
每次启动隔离进程前检查可写目录，目录中不能包含 hard link 文件。
环境打开期间，宿主必须可信地管理授权目录和 runtime 文件，包括阻止外部程序同时
修改链接。处理不可信任务内容时，应当使用专用任务目录。

每个环境管理自己的私有配置目录和只读 runtime 目录。Agent 程序无法修改 launcher
和权限配置。launcher 在 AppContainer 内启动指定程序，因此程序携带的 NTFS
policy stream 无法扩大宿主配置的权限。部分祖先目录元数据无法访问，Node 默认
使用保留符号链接的启动参数加载模块。设置 `nodePreserveSymlinks: false` 后，
宿主自行提供 Node 启动配置。Node 子进程应当继承 stdio；新建 IPC 或 pipe 资源可能
需要所选 AppContainer 配置没有授予的能力。

`startProcess()` 返回可以订阅输出与状态、取得结果和取消执行的句柄。
`runProcess()` 等待结果。超时和取消会终止后代进程并报告确认状态，错误保留已收集
的输出。`close()` 支持重复调用，终止当前操作并移除环境自建资源。无法确认终止时
拒绝清理。宿主工作区和导出文件会保留。宿主负责关闭环境，包括任务失败后的关闭。

## 交付物与任务效果

本地文件修改已经存在于配置的工作区。产物引用包含环境身份和相对文件路径。
`readArtifact()` 返回字节，`exportArtifact()` 将字节写入宿主提供的绝对路径。
导出目标归宿主管理，覆盖已有目标需要明确配置。导出调用应当放在宿主的结果处理代码中。

任务产生某种效果时，记录命令结果，并通过后续读取或相关服务 API 验证目标资源。
exit code 表示进程执行结果，目标资源的查询结果说明效果发生的位置和内容。

## Coding tools 与远程 provider

`createCodingTools({ cwd, environment, shell: { profile } })` 让四种工具使用同一个 provider。
`cwd` 必须等于环境工作目录。单独的工具 factory 也接受 `environment`；shell 需要
明确配置 profile。环境 shell 保留 provider 启动变量，并添加明确提供的工具变量。
宿主可以通过 `inheritEnv` 明确开启宿主变量继承。文件守卫调用 `operation.run()` 并
记录返回内容；`workspaceFileKey()` 包含环境身份，并根据环境平台处理大小写。
指令加载和 change preview 继续使用各自独立的宿主接口。
环境文件工具返回工作区内链接解析后的路径。

远程实现提供 `EnvironmentProviderFactory<TOptions>`：

- `create(options, context)` 创建远程环境；
- `connect(connection, context)` 连接已有环境；
- 两者返回 `EnvironmentProvider`，提供同样的文件、进程和产物操作；
- `EnvironmentConnection` 包含 endpoint、环境身份、远程工作目录和宿主管理的凭据引用；
- `description.connection` 提供 endpoint 和凭据类型，不包含凭据内容。

这个 package 定义上述接口。接入应用提供具体的远程通信实现和服务端。
远程实现负责权限执行、取消、产物传输和清理，并明确报告支持的限制和资源归属。
远程 provider 可以支持本地 Windows provider 之外的平台。
