# 快速开始

[English](../getting-started.md) | **简体中文**

本指南先在本地运行一个 May Agent，再把同一套模型/工具循环变为可恢复的 headless
application，面向仓库当前 `0.1.0` 开发预览 API。

各组件的选择方式见[构建 Agent](guides/building-an-agent.md)，运行时术语见
[Runtime 与 Session 边界](architecture/runtime-session.md)。

## 前置条件

- Node.js 20 或更高版本
- pnpm（仓库在 `package.json` 中固定了预期版本）
- 本仓库的 checkout

在仓库根目录安装并构建：

```bash
pnpm install
pnpm build
```

现有确定性示例无需 API key，展示一次 `Model -> Tool -> Model` Run：

```bash
pnpm example
```

源码位于 [`examples/basic/basic.mjs`](../../examples/basic/basic.mjs)。该示例直接使用
`@may/core`，适合一次性或嵌入式循环。本文其余部分使用 `@may/application`；需要
Session、权限、历史或 UI-independent 生命周期的产品应从这里开始。

## 创建 Workspace Package

创建 `examples/quickstart-agent/package.json`。根目录 `pnpm-workspace.yaml` 已包含
`examples/` 下的每个直接子目录。

```json
{
  "name": "@may/example-quickstart-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node agent.mjs"
  },
  "dependencies": {
    "@may/application": "workspace:*",
    "@may/core": "workspace:*",
    "@may/session": "workspace:*"
  }
}
```

这些是示例的直接依赖：

- `@may/application` 管理 headless Agent 与 Session 生命周期；
- `@may/core` 提供 JSDoc 类型引用的 `Model` 和 `Tool` 契约；
- `@may/session` 提供内存 history store。

在 monorepo 内开发时使用 `workspace:*`。仓库外用户应在 package 发布后使用具体版本。
添加 package 后再次运行 `pnpm install`，让 pnpm 建立 workspace link。

## 添加最小 Agent Application

创建 `examples/quickstart-agent/agent.mjs`：

```js
import { AgentApplication } from "@may/application";
import { InMemorySessionStore } from "@may/session";

/** @type {import("@may/core").Model} */
const model = {
  async *stream(request) {
    const latest = request.messages.at(-1);

    if (latest?.role === "tool") {
      const output = latest.content.find((part) => part.type === "json")?.value;
      const text = `The result is ${String(output)}.`;
      yield { type: "text.delta", delta: text };
      yield {
        type: "response.completed",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      };
      return;
    }

    yield {
      type: "response.completed",
      message: {
        role: "assistant",
        content: [],
        toolCalls: [
          { id: "call_add", name: "add", input: { a: 20, b: 22 } },
        ],
      },
    };
  },
};

/** @type {import("@may/core").Tool<{a: number, b: number}, number>} */
const add = {
  name: "add",
  description: "Add two numbers",
  inputSchema: {
    type: "object",
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
    required: ["a", "b"],
    additionalProperties: false,
  },
  parse(input) {
    if (
      typeof input !== "object" || input === null ||
      typeof input.a !== "number" || typeof input.b !== "number"
    ) {
      throw new TypeError("a and b must be numbers");
    }
    return { a: input.a, b: input.b };
  },
  async execute({ a, b }) {
    return a + b;
  },
};

const store = new InMemorySessionStore();
const applicationOptions = {
  model,
  store,
  tools: [add],
  instructions: "Use the add tool and answer concisely.",
  // 仅因该确定性示例中的每个工具都可信，才可这样设置。
  permissionPolicy: () => "allow",
  sessionHistory: false,
};

const application = await AgentApplication.open(applicationOptions);
const sessionId = application.sessionId;

try {
  const run = await application.submit({ input: "What is 20 + 22?" });
  const eventsDone = consumeRunEvents(application.events, run.id);
  const result = await run.result;
  await eventsDone;

  const text = result.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  console.log(`\nFinal: ${text}`);
  console.log(`Session events: ${(await application.history()).length}`);
} finally {
  await application.close();
}

// 只要进程和同一个 store 对象仍存在，内存 store 就能恢复。
const resumed = await AgentApplication.open({
  ...applicationOptions,
  sessionId,
  resume: true,
});
try {
  console.log(`Resumed session: ${resumed.sessionId}`);
  console.log(`Restored events: ${(await resumed.history()).length}`);
} finally {
  await resumed.close();
}

async function consumeRunEvents(events, runId) {
  for await (const applicationEvent of events) {
    if (applicationEvent.type !== "run.event") continue;

    const event = applicationEvent.event;
    if (event.runId !== runId) continue;
    if (event.type === "model.text.delta") process.stdout.write(event.delta);
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      return;
    }
  }
}
```

从仓库根目录运行：

```bash
pnpm --filter @may/example-quickstart-agent start
```

确定性 `model` 使示例无需网络也可复现。真实 Agent 应替换为 May provider adapter，
并将该 adapter 加为直接依赖。例如
[`examples/deepseek/deepseek.mjs`](../../examples/deepseek/deepseek.mjs) 展示了实时
DeepSeek 接线，需要 `@may/provider-deepseek`、`DEEPSEEK_API_KEY` 和受支持的模型名。

## 示例构造了什么

代码提供了通用生命周期本身无法替产品选择的行为与策略：

```text
AgentApplication
  + Model                 模型请求如何得到回答
  + Tool[]                模型可用的 capability
  + instructions          产品行为
  + PermissionPolicy      每个已校验工具调用是否可以执行
  + SessionStore          一个 Session 身份的持久化事实
  + ContextFactory        此处省略，因此使用默认内存实现
```

`AgentApplication.open()` 创建新 Session，除非同时提供 `resume: true` 和 `sessionId`。
它会安装 permission executor、创建 Core runtime、转发事件，并连接 history 与 Context
管理。

示例显式禁用可选 `session_history` 工具。需要模型查询持久化 Session history 的有界
分页时，改为传入 `sessionHistory: {}`。

## Event 与 Result 是不同接口

`application.submit()` 返回 `AgentRun` 的 Promise。Run 有两个独立观察路径：

- `run.result` 是权威最终 `RunResult`，失败时 reject；
- `application.events` 是终端、图形 UI、logger 或 approval handler 使用的实时 stream。

Application stream 将 Core event 包装为 `run.event`，permission event 包装为
`permission.event`，也可报告 tool presentation 和 Context compaction。应与 Run 并发
消费，不能等 application stream 结束后再读；它会为后续 Run 持续打开，直到
application 关闭。Buffer 压力下 streaming delta 可能丢失，所以绝不能只靠 delta
重建权威最终答案。

若 permission policy 返回 `"ask"`（或 scoped ask），event consumer 必须处理
`approval.requested` 并调用 `application.resolveApproval(requestId, decision)`，否则
工具调用会按设计保持暂停。

## 跨进程重启持久化

`InMemorySessionStore` 适合示例和测试。需要重启后保留 history 时，替换为 Node.js
file store：

```js
import { FileSessionStore } from "@may/session/file-store";

const store = new FileSessionStore(".may/sessions");
```

Package 依赖仍是 `@may/session`；`file-store` 是其导出子路径。需要把返回的 Session id
保存到可发现位置，或按[构建 Agent](guides/building-an-agent.md#单-session-还是-workspace)
所述增加 `AgentWorkspace` 和 Session Catalog。

内置 file store 写明文 JSONL，并假定每个 Session 只有一个活动 writer。它是本地后端，
不是加密多进程存储。

## 始终关闭 Owner

每个已打开 `AgentApplication` 都应用 `try`/`finally` 包裹。`close()` 会：

- 取消活动 Run 或 Context compaction；
- 拒绝待处理审批；
- 等待 Run 与 permission event relay；
- 关闭 application event stream。

关闭**不会**删除 Session history。恢复后的 application 从 history 重建模型可见对话，
同时使用当前产品版本提供的模型、工具、指令与策略。

若活动 application 由 `AgentWorkspace` 拥有，应关闭 workspace；它会关闭 application，
并等待 Catalog recording 和 event relay。

## 后续阅读

- 在选择持久化、权限、Context 策略或 UI 前阅读[构建 Agent](guides/building-an-agent.md)。
- [`@may/core` README](../../packages/core/README.md)：底层 Run loop 与 tool-executor seam。
- [`@may/application` README](../../packages/application/README.md)：单/多 Session 生命周期。
- [`@may/session` README](../../packages/session/README.md)：文件持久化与 Catalog 限制。
