# 配置 Session 存储

[English](../../en/guides/custom-storage.md) | **简体中文**

May 将持久化对话历史与 Session 发现分开：

- `SessionStore` 保存有序 `SessionEvent` 事件流，是恢复时的事实来源。
- `SessionCatalog` 保存轻量摘要，用于在 Workspace 中列出、重命名、选择和删除
  Session。

`AgentApplication` 需要 `SessionStore`，`AgentWorkspace` 还需要 `SessionCatalog`。
本文指导应用选择内置本地存储或实现数据库适配器，要求宿主已经配置模型和权限策略。
应用组合见[构建 Agent](building-an-agent.md)。

## 选择存储后端

| 要求 | 后端 |
| --- | --- |
| 进程内历史 | `@may/session` 的 `InMemorySessionStore` |
| 跨重启本地历史 | `@may/session/file-store` 的 `FileSessionStore` |
| 本地 Session 发现 | `@may/session/catalog` 的 `FileSessionCatalog` |
| 数据库、加密或跨进程协调 | 实现本文的存储接口 |

使用文件存储时可以直接阅读[内置本地存储](#内置本地存储)。
数据库适配器必须提供持久写入和顺序一致的读取。

## `SessionStore` 接口

```ts
interface SessionStore {
  readonly directory?: string;
  append(event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<readonly SessionEvent[]>;
  inspect?(sessionId: string): Promise<readonly SessionEvent[]>;
  delete?(sessionId: string): Promise<boolean>;
}
```

`read()` 必须按序号升序返回完整事件流。每个事件必须具有所请求的 Session 标识，
且 `seq` 从 1 开始连续。May 会在回放前校验这些条件。

`append()` 必须完整、持久地保存一个事件，或拒绝写入；不能确认一个随后可能静默
丢失的缓冲写入。Session 会串行化通过单个 Session 实例发出的写入，共享
后端仍需跨进程原子检查下一个序号。

`inspect()` 返回已提交历史，读取过程不会修复记录、改变写入者归属或写入
存储。Session 分支以及工作区历史和树形浏览需要这个操作。完整请求的可恢复边界
使用 `run.settled` 保存；分支在 `session.created.fork` 中记录准确来源，并通过
`session.fork.ready` 确认初始化完成。未完成的分支可以读取历史，恢复操作会报告错误。
自定义适配器必须保留这些事件，并报告失败的写入。
`run.settled.hostCompleted: true` 表示宿主保存最终应用状态，并确认调度器交还控制的
Run 已经成功完成。

<a id="数据库-adapter-骨架"></a>

## 数据库适配器框架

在依赖 `@may/session` 的应用中创建适配器模块。
下面的 `SessionEventTable` 是数据库集成接口，需要使用数据库库提供具体实现，
才能创建存储。`appendIfCurrentSequence` 必须在同一事务中检查当前最大序号并插入记录。

```ts
import {
  validateSessionHistory,
  type SessionEvent,
  type SessionStore,
} from "@may/session";

export interface SessionEventTable {
  appendIfCurrentSequence(input: {
    readonly sessionId: string;
    readonly expectedCurrentSequence: number;
    readonly nextSequence: number;
    readonly json: string;
  }): Promise<boolean>;

  readAscending(sessionId: string): Promise<readonly string[]>;
  deleteSession(sessionId: string): Promise<boolean>;
}

export class DatabaseSessionStore implements SessionStore {
  constructor(private readonly table: SessionEventTable) {}

  async append(event: SessionEvent): Promise<void> {
    const committed = await this.table.appendIfCurrentSequence({
      sessionId: event.sessionId,
      expectedCurrentSequence: event.seq - 1,
      nextSequence: event.seq,
      json: JSON.stringify(event),
    });
    if (!committed) {
      throw new Error(
        `Session ${event.sessionId} is no longer at sequence ${event.seq - 1}`,
      );
    }
  }

  async read(sessionId: string): Promise<readonly SessionEvent[]> {
    const rows = await this.table.readAscending(sessionId);
    const events = rows.map((row, index) => decodeEvent(row, index + 1));
    validateSessionHistory(sessionId, events);
    return events;
  }

  delete(sessionId: string): Promise<boolean> {
    return this.table.deleteSession(sessionId);
  }

  inspect(sessionId: string): Promise<readonly SessionEvent[]> {
    return this.read(sessionId);
  }
}

function decodeEvent(source: string, row: number): SessionEvent {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`Invalid session event JSON in row ${row}`);
  }
  if (
    typeof value !== "object" || value === null ||
    !("type" in value) || typeof value.type !== "string" ||
    !("sessionId" in value) || typeof value.sessionId !== "string" ||
    !("seq" in value) || typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    !("timestamp" in value) || typeof value.timestamp !== "number"
  ) {
    throw new Error(`Invalid session event in row ${row}`);
  }
  return value as SessionEvent;
}
```

应在 `(session_id, seq)` 上建立唯一约束，并在插入事务中锁定或比较 Session
当前序号。唯一约束能发现重复序号，两个写入者仍可能因错误重试逻辑
制造序号缺口。

上述解码器与内置文件存储一样，只校验事件公共字段。若后端接收来自
May 可信进程之外的数据，还应按事件类型校验每个事件内容、限制大小，再
转换为 `SessionEvent`。

## `SessionCatalog` 接口

```ts
interface SessionCatalog {
  list(workspace: string): Promise<readonly SessionSummary[]>;
  record(summary: SessionSummary): Promise<void>;
  rename?(sessionId: string, workspace: string, title: string): Promise<boolean>;
  remove?(sessionId: string, workspace: string): Promise<boolean>;
}
```

Catalog 实现应新增或更新摘要，并保留已有 `createdAt`，按规范化工作目录隔离记录，
通常先返回最近使用的 Session。`rename` 与 `remove` 可选；缺少时 Workspace 控制器
会报告不支持该操作。

Catalog 提供索引，Session 历史保存对话事实。普通 Run 的 Catalog 更新失败时，
`AgentWorkspace` 继续保留运行结果。需要可靠索引的应用应提供从 Session 历史重建的路径。

## 内置本地存储

将 `@may/application` 和 `@may/session` 加入应用直接依赖，在入口初始化
`model`、`tools` 和 `permissionPolicy` 后使用下面的组合片段。
路径以进程工作目录为基准：

```ts
import { AgentApplication, AgentWorkspace } from "@may/application";
import { FileSessionCatalog } from "@may/session/catalog";
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
const catalog = new FileSessionCatalog(".may/catalog.json");

const workspace = await AgentWorkspace.open({
  workspace: process.cwd(),
  store,
  catalog,
  openApplication: ({ sessionId, resume }) => AgentApplication.open({
    model,
    tools,
    permissionPolicy,
    store,
    resume,
    ...(sessionId === undefined ? {} : { sessionId }),
  }),
});

try {
  const run = await workspace.submit({ input: "Inspect the current state" });
  await run.result;
} finally {
  await workspace.close();
}
```

JSONL Session 存储是明文，并假定每份 Session 历史只有一个活动写入者。文件
Catalog 在本地多个进程间使用追加式原子操作文件，默认不自动整理操作
目录。多主机协调和加密由自定义后端提供。停止其他 Catalog 使用者后可以调用
`compact({ confirmHostsStopped: true })`，完整步骤见[本地存储维护](#本地存储维护)。

## 验证持久化

保存活动的 `workspace.sessionId`，关闭工作区，然后使用相同存储路径和该 `sessionId`
重新打开。确认 `history()` 返回提交输入和完整响应。
数据库后端还需要确认过期序号的写入请求被拒绝，已保存历史保持不变。
通过 `inspect()` 检查浏览过程中没有发生写入。

## 失败与生命周期规则

- 传播存储错误，绝不能把错误变成空历史。
- 不要原地编辑或重新编号已保存事件。
- 追加重试必须幂等，或能识别完全相同的事件已保存。
- 接受不可信记录前限制事件与历史大小。
- 把 Session 元数据、模型消息、工具输出、审批和工具显示信息都视为潜在敏感数据。
- 保留策略、备份、加密与访问控制由后端或部署实现。
- `AgentApplication.close()` 或 `AgentWorkspace.close()` 完成后再关闭数据库连接池。

历史删除和 Catalog 移除分别执行。两种接口使用不同系统时，
需要提供部分失败后的状态核对与处理。

Context 工作集与持久化历史的区别见[自定义 Context](custom-context.md)，完整生命周期
见 [Runtime 与 Session 边界](../architecture/runtime-session.md)。

## 本地存储维护

同一个 `FileSessionStore` 实例按 Session 串行执行读取、写入与残尾修复。追加操作仅在
文件身份、长度和时间戳一致时复用上次验证的序号；显式历史读取仍校验完整记录。
`input.generated` 记录保存 Hook 追加的继续执行消息，以及分支继承的已交付补充输入。
读取和只读检查会在 Session 恢复前校验 Run 身份、正整数 `step`、用户消息内容及 `reason`。
每个文件仍要求单个写入者。POSIX 上新建会话后同步父目录；Node 没有等价的 Windows 目录 fsync。

需要合并目录操作文件时，停止其他目录使用者，对 `FileSessionCatalog` 调用
`await catalog.compact({ confirmHostsStopped: true })`。原子写入的版本 2 快照在清理前
记录已吸收的精确操作文件名，因此清理中断不会重复重放。合并后不能使用旧版读取器；
普通版本 1 目录仍可读取。

本地写入者锁可从 `@may/session/file-store` 导入 `recoverFileLock` 处理。必须先停止所有
竞争宿主、打开和恢复操作，检查锁内容，再以 `expectedContents` 传入完整原文，并设置
`confirmHostsStopped: true`。辅助函数拒绝存活 PID、远端宿主、危险链接和已变化的元数据。
元数据不完整时，独立核实所有者后还需显式设置 `confirmUnknownOwner: true`。
PID 探测与锁获取分别执行，恢复需要在其他获取锁操作全部停止后进行。
释放锁仅改变所属关系。
