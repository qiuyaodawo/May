# 构建 Agent

[English](../../en/guides/building-an-agent.md) | **简体中文**

May 是一组可组合 package，而不是单一的预配置 assistant。应用选择行为与策略，框架
提供执行和生命周期机制。本文基于仓库当前已实现的 API 说明这些选择。

尚未运行 Agent 时先阅读[快速开始](../getting-started.md)。Agent definition、Session、
Run 和 Step 见 [Runtime 与 Session 边界](../architecture/runtime-session.md)。

> **当前 API：** 在 May `0.1.0` 中，“Agent definition”是设计概念，而不是
> `defineAgent()` 函数。工具通过数组传入，也没有全局 `ToolRegistry`。应像下文一样
> 用普通 factory 组合产品，不要依赖尚不存在的 API。

## 组合模型

```text
Product-owned decisions
  model + instructions + tools + permission policy + Context policy
                              |
                              v
                    AgentApplication
                              |
               Session + permission executor
                              |
                              v
                     May (Core runtime)
                              |
                Model <-> tools, by Steps

Optional product shell
  AgentWorkspace -> active AgentApplication -> Session Catalog
  UI             -> controller methods + application/workspace events
```

依赖的重要规则是单向：`apps/` 下的可执行产品选择 package，可复用 package 不导入产品。
MaybeCode 是参考组合，不是必需 superclass 或 runtime。

## 先选择生命周期层级

| 从这里开始 | 适用场景 | 需要自行负责 |
| --- | --- | --- |
| `@may/core` 的 `May` | 一次性、临时或深度嵌入式执行 | Run 上层的 Context 连续性、持久化、权限与关闭 |
| `@may/session` 的 `Session` | 需要持久化对话身份，但希望手工组装生命周期 | Runtime 重建、permission event 持久化、发现和 UI relay |
| `@may/application` 的 `AgentApplication` | Headless 产品需要一个活动、可恢复 Session | 产品模型、工具、指令、策略、存储和 event handling |
| `@may/application` 的 `AgentWorkspace` | 用户需要创建、列出、恢复、重命名或删除 Session | Application factory、`SessionCatalog` 和产品配置迁移 |

多数交互产品应从 `AgentApplication` 开始。只有 Core 故意保持的小边界恰好是所需能力时，
才直接使用 Core。不要在 `AgentApplication` 外再包一层 `Session`，它已经拥有一个。

## 必需与可选输入

`AgentApplication.open()` 必须提供：

- 一个 `Model`；
- 一个 `SessionStore`；
- 一个 `PermissionPolicy`。

其余均是明确的可选选择：

- `tools` 默认不包含产品工具；
- `instructions` 默认没有 system instruction；
- `contextFactory` 默认为 `InMemoryContextFactory`；
- 未配置时禁用 Context budget 与 compaction；
- 只有同时提供 `sessionId` 与 `resume: true` 才恢复旧 Session；
- 只有 `sessionHistory` 是 option object 时才安装有界 `session_history` 工具；
- 只有产品提供 `createToolPresentation` 才生成工具呈现 metadata。

## 把组合集中在一个 Factory

下面是完整的 provider-neutral TypeScript application factory。调用方可传入任何实现
Core `Model` 契约的对象。

该文件需要的 workspace dependency：

```json
{
  "dependencies": {
    "@may/application": "workspace:*",
    "@may/context": "workspace:*",
    "@may/core": "workspace:*",
    "@may/session": "workspace:*"
  }
}
```

```ts
import { AgentApplication, type AgentApplicationOptions } from "@may/application";
import { InMemoryContextFactory, PruneOldToolResultsStrategy } from "@may/context";
import type { Model, Tool } from "@may/core";
import type { SessionStore } from "@may/session";

export interface OpenExampleAgentOptions {
  readonly model: Model;
  readonly store: SessionStore;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly resume?: boolean;
}

const lookup: Tool<{ key: string }, { value: string | null }> = {
  name: "lookup",
  description: "Look up a value in the product's read-only data source",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  parse(input) {
    if (
      typeof input !== "object" || input === null ||
      !("key" in input) || typeof input.key !== "string"
    ) {
      throw new TypeError("key must be a string");
    }
    return { key: input.key };
  },
  async execute({ key }, context) {
    context.signal.throwIfAborted();
    return { value: key === "status" ? "ready" : null };
  },
};

export function openExampleAgent(
  options: OpenExampleAgentOptions,
): Promise<AgentApplication> {
  const prune = new PruneOldToolResultsStrategy({
    keepRecentToolResults: 4,
    minimumResultBytes: 2_048,
  });

  const applicationOptions: AgentApplicationOptions = {
    model: options.model,
    store: options.store,
    tools: [lookup],
    instructions: [
      "You are Example Agent.",
      "Use lookup when a requested value may exist in the data source.",
      "Do not invent missing values.",
    ].join("\n"),
    metadata: { workspace: options.workspace, agent: "example" },
    contextMetadata: { workspace: options.workspace },
    permissionPolicy: ({ tool }) =>
      tool.name === "lookup" ? "allow" : "deny",
    contextFactory: new InMemoryContextFactory(),
    contextBudget: {
      contextWindowTokens: 64_000,
      outputReserveTokens: 4_096,
      toolReserveTokens: 2_048,
      safetyMarginTokens: 1_024,
      compactTriggerRatio: 0.9,
    },
    compactionStrategy: prune,
    autoCompactionStrategies: [prune],
    sessionHistory: {
      maxEvents: 50,
      maxOutputBytes: 32 * 1_024,
      maxEventBytes: 8 * 1_024,
    },
    maxSteps: 16,
    ...(options.sessionId === undefined
      ? {}
      : { sessionId: options.sessionId }),
    ...(options.resume === true ? { resume: true } : {}),
  };

  return AgentApplication.open(applicationOptions);
}
```

这个 factory 就是产品实际的 Agent definition。它容易测试，也让所有会改变行为的选择
集中在一处接受 review。64,000 token budget 只是示例值，**不代表所有模型**；应使用
所选 provider/model 的文档限制，并为输出和预期工具 payload 保留足够空间。

## 显式作出每个组合决策

### 模型与 Provider

Core 依赖 provider-neutral `Model`。在产品边界选择一个具体 adapter，并把它作为直接
依赖；secret 不能放入 Session metadata 或 instruction。

例如，DeepSeek 入口可以先构造模型，再调用 factory：

```ts
import { DeepSeekModel } from "@may/provider-deepseek";

const apiKey = process.env.DEEPSEEK_API_KEY;
const modelName = process.env.DEEPSEEK_MODEL;
if (!apiKey || !modelName) {
  throw new Error("Set DEEPSEEK_API_KEY and DEEPSEEK_MODEL");
}

const model = new DeepSeekModel({ apiKey, model: modelName });
```

这还需要 `"@may/provider-deepseek": "workspace:*"`。其他内置 provider package 见
[配置参考](../reference/configuration.md)。Adapter 将输出标准化为 Core event，但继续
负责 provider request format、支持的 content、重试和原生 continuation state。

### 指令

Instruction 是产品策略，应描述 Agent 角色、边界、可用 workflow 与输出要求，不能嵌入
secret。

编码产品可用 `@may/coding-tools/instructions` 安全组合默认 system prompt 与有边界的
runtime/workspace instruction file。通用产品可以自行加载或生成 string。Session 恢复
时，应用使用**当前**产品配置提供的 instruction；Session history 不是整个 Agent
definition 的冻结副本。

### 工具

Tool 拥有一个 capability、JSON Schema、可选 parser、execution 与 cancellation 行为。
即使已提供 schema，也应实现严格 `parse()`：parser 将 provider 输出转换为已校验、
typed value，并在 runtime 拒绝 malformed input。

Runtime 内工具名必须唯一；`May` 拒绝重复。启用可选 history tool 时，
`AgentApplication` 保留 `session_history`。当前 API 通过数组组合工具；工具分组 function
应放在本地 tool package 或产品中，不要假设存在全局 registry。

工具接收 `AbortSignal`，并可通过 `context.report(...)` 报告实时进度。I/O 和 subprocess
应尊重取消。普通工具 failure 变成模型可见 error result，fatal error 只用于无法安全
继续的基础设施失败。

横切执行行为属于 Core `ToolExecutor` seam。`AgentApplication` 接受 `toolExecutor`，
再用 permission executor 包装它，因此 logging、sandbox dispatch 或 timeout 可以注入，
无需修改每个 Tool。

### Permission 不是 Sandbox

`PermissionPolicy` 在工具输入解析后、执行前运行：

```ts
const permissionPolicy = ({ tool, input }) => {
  if (tool.name === "read") return "allow";
  if (tool.name === "write") {
    return {
      decision: "ask",
      grantKey: `write:${JSON.stringify(input)}`,
    };
  }
  return "deny";
};
```

`"allow-session"` 只适用于带 `grantKey` 的 scoped ask；grant 存在于 application 的
permission executor，关闭时消失。后续调用仍会重新评估 policy，因此后续 `"deny"`
优先。

策略要求审批时，event handler 必须展示请求并调用：

```ts
await application.resolveApproval(requestId, "allow");
// 其他决定："allow-session" 或 "deny"。
```

审批只决定操作是否运行，不限制被允许的进程、网络请求或文件操作能影响什么。执行
不可信内容时，除权限之外还要在 Tool 或 `ToolExecutor` 边界提供受限执行后端。
`@may/coding-tools` 的 shell 明确不是 sandbox。

### Context 与压缩

Context 是当前模型可见视图，不是持久化 audit log。默认 `InMemoryContextFactory`
可通过 controller 提供检查、手动和自动压缩。

以下内容要分别选择：

1. **Budget：** model window 减去 output、tool 与 safety reserve。
2. **手动策略：** 显式 `application.compactContext()` 使用的 `compactionStrategy`。
3. **自动链：** 到达 trigger 时按顺序尝试的 `autoCompactionStrategies`。
4. **原生压缩：** 只有没有显式自动链时，`providerNativeAutoCompaction: true` 才加入
   model adapter 的 native compactor。需要精确排序时，用
   `ModelContextCompactionStrategy` 包装并放入显式链。

框架会在继续之前把变化后的压缩视图持久化为 Session event，旧的持久化事实仍留在
history。Agent 需要找回从 Context 移除的细节时，启用有界 `session_history` 或提供
另一种 retrieval 机制。

### Session 存储

按部署边界选择：

- `InMemorySessionStore`：确定性测试、demo 或进程本地工作；
- `@may/session/file-store` 的 `FileSessionStore`：跨重启本地明文 JSONL；
- 产品实现的 `SessionStore`：数据库、加密、远程存储或更强并发要求。

内置 file store 假定每个 Session 一个活动 writer。没有在产品或后端增加控制时，不能
在其上承诺多进程或分布式协调。

Session metadata 只应包含恢复时用于校验的稳定、非 secret 事实。用 `validateSession`
拒绝属于不兼容 workspace 或产品的 history。模型、API key、可执行 Tool 对象和
permission grant 都是 runtime 配置，不会从 Session log 恢复。

### 工具呈现 Metadata

部分 UI 需要在请求审批前得到 diff 等信息。提供 `createToolPresentation(check)`，返回
带 namespace、version 且 JSON-safe 的 metadata。`AgentApplication` 在权限评估前记录
它并实时发出 `tool.presentation`，Session 有意不把它加入模型可见对话。

产品拥有 `kind`、`version` 和 data schema，应防御性解码持久化数据。编码产品可以复用
`@may/coding-tools/change-preview`，无需再发明格式。

## 消费一个有序 Application Stream

长生命周期 UI 通常在打开 application 后立刻启动一个 relay：

```ts
const relay = (async () => {
  for await (const event of application.events) {
    switch (event.type) {
      case "run.event":
        renderRunEvent(event.event);
        break;
      case "permission.event":
        await handlePermissionEvent(event.event);
        break;
      case "tool.presentation":
        renderToolPresentation(event.presentation);
        break;
      case "context.compacted":
      case "context.compaction.failed":
        renderContextNotice(event);
        break;
    }
  }
})();

try {
  const run = await application.submit({ input: "Inspect the current state" });
  const result = await run.result;
  renderFinalMessage(result.message);
} finally {
  await application.close();
  await relay;
}
```

这些 render/handler function 有意留给产品/UI 实现。终端产品可以使用 `@may/tui`
Agent transcript，图形或远程 client 可以直接消费同一 headless stream。

把 stream 当作实时观察：

- 用 `runId` 关联 Run event，并按 `seq` 排序；
- 有界 queue 压力下容忍 text、reasoning、output 或 progress delta 缺口；
- 用 `run.result` 与 `application.history()` 获取权威最终数据；
- 可能出现审批时持续消费；
- 即使已渲染 terminal failure event，也要处理 rejected result。

每个 `AgentApplication` 只允许一个活动 Agent 操作。`cancel()` 取消活动 Run 或压缩；
只有最近 Run 失败时 `retry()` 才有效，并且不会追加重复用户消息。

## 单 Session 还是 Workspace

产品一次只处理一个已知 Session 且在其他地方保存 id 时，单用 `AgentApplication`。
需要发现与切换时加入 `AgentWorkspace`。

下列本地组合使用相同 application dependency，以及 `@may/session/catalog` 和
`@may/session/file-store` 导出路径：

```ts
import { AgentWorkspace } from "@may/application";
import { FileSessionCatalog } from "@may/session/catalog";
import { FileSessionStore } from "@may/session/file-store";
import { join } from "node:path";

const stateDirectory = join(process.cwd(), ".may");
const store = new FileSessionStore(join(stateDirectory, "sessions"));
const catalog = new FileSessionCatalog(join(stateDirectory, "catalog.json"));

const workspace = await AgentWorkspace.open({
  workspace: process.cwd(),
  store,
  catalog,
  autoResume: true,
  openApplication: ({ sessionId, resume }) =>
    openExampleAgent({
      model,
      store,
      workspace: process.cwd(),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(resume ? { resume: true } : {}),
    }),
});

try {
  const run = await workspace.submit({ input: "Read the status value" });
  await run.result;

  const summaries = await workspace.listSessions();
  const newSessionId = await workspace.newSession();
  await workspace.resumeSession(summaries[0]?.id ?? newSessionId);
} finally {
  await workspace.close();
}
```

`SessionStore` 保存完整 event history；`SessionCatalog` 是用于列出和选择的独立轻量
索引，Catalog record 不会追加到模型 Context。内置 file Catalog 保存 base JSON
snapshot 与 append-only operation file，并且不自动压缩 operation file。

`AgentWorkspace` 串行化提交和 Session mutation，发出 `session.changed`，并更新 Catalog
summary。改变模型或其他 runtime 配置的产品可以使用 `transitionApplication()` 在同一
Session 上打开替换 application。Profile 选择等产品状态应留在通用 workspace 之外。

## History、Context、Event 与 Catalog

四组数据相关，但不可互换：

| 数据 | 用途 | 持久化？ | 模型可见？ |
| --- | --- | --- | --- |
| 实时 application/Core event | Streaming UI、progress、approval protocol | 否；有界 relay 可能丢 delta | 本身不可见 |
| Session history | 有序最终事实与可恢复 audit trail | 是，由所选 store 决定 | 回放事实重建 Context；presentation metadata 除外 |
| Context | 选择/压缩后的当前请求视图 | 只有 application 记录替换 checkpoint 时 | 是 |
| Session Catalog | id、workspace、标题、预览、时间戳等发现索引 | 由所选 catalog 决定 | 否 |

不要把 transcript 作为事实来源。UI transcript 只是投影；应从持久化 history 重建，再
应用实时事件。

## 关闭与 Ownership

拥有低层对象的 owner 负责关闭它们：

- Core `RunHandle` 可取消，但 `May` 本身没有 close method；
- `AgentApplication` 关闭活动 Run/压缩、permission executor 和 event relay；
- `AgentWorkspace` 关闭活动 application、串行状态队列、Catalog recording tail 和
  workspace event stream。

始终在 `finally` 中关闭。提交前启动长生命周期 event relay，关闭 owner 后再等待 relay，
使其能观察 stream completion。不要单独关闭由 workspace 拥有的 application。

## 实用构建清单

在把 Agent 产品视为完成前，确认它明确回答：

- **行为：** 哪些 instruction 是默认、runtime addition 或 workspace-controlled addition？
- **Provider：** Credential 从哪里加载，支持哪些模型限制和 content form？
- **Capability：** 工具名是否唯一，输入是否解析，输出是否有限，取消是否转发？
- **安全：** 哪些调用 allow/deny/ask？审批之外有什么机制限制已允许工具？
- **Context：** 实际 model budget 是多少，何时压缩，Agent 能否找回被省略历史？
- **持久化：** 使用内存、本地单 writer，还是满足并发/加密要求的自定义后端？
- **事件：** 是否有持续 consumer 处理审批与 terminal failure，而不把 delta 当权威数据？
- **Session：** 如何发现 id、校验 metadata、拒绝不兼容恢复？
- **生命周期：** 谁负责取消与 `close()`，包括启动或渲染失败时？
- **产品边界：** 其他 UI 或 provider 能否复用 headless 组合，而不导入产品渲染代码？

## 相关 Package 文档

- [`@may/core`](../../../packages/core/README.md)：执行循环、Tool/Model 契约、实时事件和
  executor/scheduler seam
- [`@may/application`](../../../packages/application/README.md)：headless 单 Session 与
  workspace 生命周期
- [`@may/context`](../../../packages/context/README.md)：检查、budget 与压缩策略
- [`@may/session`](../../../packages/session/README.md)：持久化 history、恢复、file store
  与 Catalog
- [`@may/permissions`](../../../packages/permissions/README.md)：headless policy 与审批协议
- [`@may/coding-tools`](../../../packages/tools/coding-tools/README.md)：有界编码 capability、
  指令、preview 与 shell 安全边界
