# 自定义 Session 存储

[English](../../guides/custom-storage.md) | **简体中文**

May 将持久化对话历史与 Session 发现分开：

- `SessionStore` 保存有序 `SessionEvent` stream，是恢复时的事实来源。
- `SessionCatalog` 保存轻量 summary，用于在 workspace 中列出、重命名、选择和删除
  Session。

`AgentApplication` 需要 `SessionStore`；`AgentWorkspace` 还需要 `SessionCatalog`。

## `SessionStore` 契约

```ts
interface SessionStore {
  append(event: SessionEvent): Promise<void>;
  read(sessionId: string): Promise<readonly SessionEvent[]>;
  delete?(sessionId: string): Promise<boolean>;
}
```

`read()` 必须按 sequence 升序返回完整 stream。每个事件必须具有所请求的 Session ID，
且 `seq` 从 1 开始连续。May 会在回放前校验这些条件。

`append()` 必须完整、持久地 commit 一个事件，或 reject；不能确认一个随后可能静默
丢失的 buffered write。Session 会串行化通过单个 Session 实例发出的写入，但共享
后端仍需跨进程原子检查 next sequence。

## 数据库 Adapter 骨架

下面把数据库细节隔离在小型 transactional port 后。
`appendIfCurrentSequence` 必须在同一事务内检查当前最大 sequence 并插入新 row。

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

应在 `(session_id, seq)` 上建立 unique constraint，并在插入事务中锁住或比较 Session
当前 sequence。仅靠 unique constraint 能发现重复 sequence，但无法阻止两个 writer
因错误重试逻辑制造 gap。

上述 decoder 与内置 file store 一样，只校验公共 event envelope。若后端接收来自
May 可信进程之外的数据，还应校验每个 discriminated event payload、限制大小，再
cast 为 `SessionEvent`。

## `SessionCatalog` 契约

```ts
interface SessionCatalog {
  list(workspace: string): Promise<readonly SessionSummary[]>;
  record(summary: SessionSummary): Promise<void>;
  rename?(sessionId: string, workspace: string, title: string): Promise<boolean>;
  remove?(sessionId: string, workspace: string): Promise<boolean>;
}
```

Catalog 实现应 upsert summary 但保留已有 `createdAt`，按规范化 workspace 隔离记录，
通常先返回最近使用的 Session。`rename` 与 `remove` 可选；缺少时 workspace controller
会报告不支持该操作。

Catalog 是索引，不是对话事实。`AgentWorkspace` 有意容忍 Catalog record 失败，避免
仅因最近 Session 列表未更新就丢失 Agent Run。若 Catalog 持久性很重要，应提供从
Session history 重建的路径。

## 内置本地存储

本地 Node.js 产品无需自定义 adapter：

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
```

JSONL Session store 是明文，并假定每个 Session history 只有一个活动 writer。File
Catalog 在本地进程间使用 append-only 原子 operation file，但不自动压缩 operation
directory。二者都不是多主机数据库或加密 secret store。

## 失败与生命周期规则

- 传播 storage error，绝不能把错误变成空 history。
- 不要原地编辑或重新编号已 commit 事件。
- Append retry 必须幂等，或能识别完全相同的事件已 commit。
- 接受不可信记录前限制 event 与 history 大小。
- 把 Session metadata、模型消息、工具输出、审批和 tool presentation 都视为潜在敏感数据。
- Retention、backup、encryption 与 access control 由后端或部署实现，May 不会自动添加。
- `AgentApplication.close()` 或 `AgentWorkspace.close()` 完成后再关闭数据库 pool。

History 删除和 Catalog 移除是两个调用，不是跨 store 事务。两种接口使用不同系统时，
需要为部分失败设计 reconcile 机制。

Context 工作集与持久化历史的区别见[自定义 Context](custom-context.md)，完整生命周期
见 [Runtime 与 Session 边界](../architecture/runtime-session.md)。
