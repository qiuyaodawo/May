# 实现并注册工具

[English](../../en/guides/custom-tool.md) | **简体中文**

本文指导应用定义工具、校验参数、注册工具并处理取消。
需要已经按照[构建 Agent](building-an-agent.md)配置应用和模型。

`@may/core` 的 `Tool` 接口包含三个主要部分：

- `inputSchema` 向模型描述调用；
- 可选 `parse()` 校验并转换不可信的模型输出；
- `execute()` 执行操作。

`@may/core` 提供实例级 `ToolRegistry`，用于组合和查询工具。
`May`、`AgentApplication` 和 `AgentDefinition` 都接受
`Iterable<Tool>`，所以可以传注册表、数组或其他可迭代对象。

## 完整工具示例

在 TypeScript 应用中创建 `add-tool.ts`，并将 `@may/core` 加入直接依赖。
该文件实现加法，`execute()` 返回 `{ value: number }`。

```ts
import type { Tool } from "@may/core";

interface AddInput {
  readonly left: number;
  readonly right: number;
}

interface AddOutput {
  readonly value: number;
}

export const addTool: Tool<AddInput, AddOutput> = {
  name: "add",
  description: "Add two finite numbers.",
  inputSchema: {
    type: "object",
    properties: {
      left: { type: "number" },
      right: { type: "number" },
    },
    required: ["left", "right"],
    additionalProperties: false,
  },

  parse(input): AddInput {
    if (typeof input !== "object" || input === null) {
      throw new TypeError("add input must be an object");
    }
    const value = input as Record<string, unknown>;
    if (!Number.isFinite(value.left) || !Number.isFinite(value.right)) {
      throw new TypeError("left and right must be finite numbers");
    }
    return { left: value.left as number, right: value.right as number };
  },

  async execute(input, context): Promise<AddOutput> {
    context.signal.throwIfAborted();
    context.report({ type: "progress", message: "Adding values" });
    return { value: input.left + input.right };
  },
};
```

在应用组合模块中从 `./add-tool.js` 导入 `addTool`，与已初始化的 `productTools` 组合。
以下片段需要宿主提供 `model`、`permissionPolicy` 和 `store`，工作结束后按照
构建指南关闭应用：

```ts
import { defineAgent } from "@may/application";
import { ToolRegistry } from "@may/core";

const tools = new ToolRegistry([addTool]);
tools.registerAll(productTools);

const agent = defineAgent({
  model,
  tools,
  permissionPolicy,
});

const application = await agent.open({ store });
```

`inputSchema` 向模型描述输入。工具必须在 `parse()` 或 `execute()` 中执行运行时校验。
权限策略接收解析后的值。

## 使用 `ToolRegistry` 组合工具

注册表保留注册顺序，并在实例内保证名字唯一。以下 API 片段中的其他工具由宿主提供：

```ts
import {
  DuplicateToolNameError,
  ToolRegistry,
} from "@may/core";

const tools = new ToolRegistry([addTool]);
tools.register(subtractTool);
tools.registerAll([multiplyTool, divideTool]);

console.log(tools.size);
console.log(tools.has("add"));
console.log(tools.get("missing"));       // undefined
console.log(tools.require("add").name); // "add"

for (const tool of tools) {
  console.log(tool.name);
}

const names = tools.names();
const executableTools = tools.values();
const modelTools = tools.definitions();
const extended = tools.clone().register(powerTool);
const combined = ToolRegistry.compose(coreTools, productTools);
```

API 语义如下：

| API | 行为 |
| --- | --- |
| `new ToolRegistry(tools?)` | 从一个可迭代对象注册初始工具 |
| `register(tool)` | 原子注册单个工具并返回同一注册表 |
| `registerAll(tools)` | 原子注册整批工具并返回同一注册表 |
| `size`、`has(name)` | 查询数量或名字是否存在 |
| `get(name)` | 返回工具或 `undefined` |
| `require(name)` | 返回工具；缺失时抛出 `ToolNotFoundError` |
| `names()`、`values()` | 返回注册顺序的数组快照 |
| `definitions()` | 返回不含解析或执行回调的模型侧定义快照 |
| `snapshot()` | 为一次 Run 冻结工具定义、Schema 和回调 |
| `clone()` | 创建可独立继续注册的新注册表 |
| `[Symbol.iterator]()` | 按注册顺序迭代工具 |
| `ToolRegistry.compose(...sources)` | 按输入顺序组合多个可迭代对象 |

`registerAll()` 会先完整消费并校验输入。若工具无效、与现有名字重复，或同一批输入中
出现重名，它会抛出 `TypeError` 或 `DuplicateToolNameError`，且**不注册该批中的任何
工具**。`register()` 具有相同的单项原子性。`compose()` 遇到重复名字也会失败。
`DuplicateToolNameError` 是带 `code: "DUPLICATE_TOOL_NAME"` 的 `MayError`，
其 `toolName` 属性保存冲突名称。

`names()`、`values()` 和 `definitions()` 返回新数组；`clone()` 不共享可变注册表
映射。注册表返回注册时的原始 `Tool` 对象身份，以便调用方继续使用基于
`WeakMap<Tool, ...>` 的元数据。

注册时，注册表会保存工具描述字段的值或引用：`name`、`description`、
`inputSchema` 引用、`parse`、`execute`、`resultContent` 和 `permissionVersion`。
TypeScript 的 `Tool` 接口将这些字段声明为
`readonly`。若 JavaScript 或类型断言在注册后替换其中任意字段，之后通过
`get()`/`require()`/`values()` 取出工具、迭代、克隆、组合或生成定义时会
抛出 `TypeError` 并终止当前查询。
`inputSchema` 只比较对象引用，并不会被深度冻结；因此调用方仍必须把 Schema 及已注册
Tool 的描述字段视为稳定值。工具的其他内部运行状态可以按产品资源归属规则
变化。

`May` 在构造时保存传入可迭代对象的成员快照，之后向源注册表注册工具不会改变该
运行时。`defineAgent()` 也在创建 Definition 时保存工具成员快照，之后每次 `open()` 都使用
同一组工具。直接 `AgentApplication.open()` 会在打开期间快照工具。若产品需要不同
能力集合，应显式创建新的运行时或 Definition。

<a id="execution-context"></a>

## 工具执行环境

每次调用都会收到 `ToolExecutionContext`：

- `runId`、`step`、`toolCallId` 用于关联事件；
- `idempotencyKey` 对该调用保持稳定，外部 API 支持去重时应使用它；
- `signal` 与所属 Run 一起取消操作；
- `report()` 发出实时 `output.delta` 或结构化 `progress`。

进度通过实时事件展示。`execute()` 必须返回完整结果，持久化记录依据该返回值。

长时间任务应把 `signal` 传给每个可取消依赖，并在不可取消阶段之间检查：

```ts
async execute(input, context) {
  const response = await fetch(input.url, { signal: context.signal });
  context.signal.throwIfAborted();
  return { status: response.status, body: await response.text() };
}
```

若副作用可能在取消前已经生效，工具必须自行定义恢复或幂等行为。May 无法撤销
外部副作用。

## 失败语义

校验错误或普通执行错误会成为 `tool.failed` 事件和错误工具消息，模型可在下一
Step 观察并恢复。只有继续 Run 会不安全时（例如授权或持久化边界损坏）才抛出
`FatalToolExecutionError`。

Run 收到取消信号后应停止报告进度并尽快退出。
Core 会为完成前被取消的调用记录终结结果，使恢复后的历史中每个
工具调用都有匹配结果。

工具名在运行时内必须唯一；`May` 构造内部注册表，因此重名会抛出
`DuplicateToolNameError`。若 `AgentApplication` 启用可选 `session_history`，该名字由
Application 保留。

Core 默认串行调度。只有同一模型响应选择的每个工具都可安全并发、且结果按调用顺序
仍有意义时，才使用 `parallelToolScheduler`。

## 安全边界

工具使用应用的进程权限执行，宿主需要明确限制其操作范围：

- 把模型参数视为恶意输入；
- 限制输入、输出、运行时间、重试与资源使用；
- 强制工作目录边界时规范化文件路径并检查链接；
- 不要返回凭据或敏感环境数据，因为工具结果对模型可见且会持久化；
- 网络和数据库使用最小权限客户端；
- 用户授权放在独立权限策略中。

审批控制能力是否可以运行，批准后进程的访问范围由执行后端限制。参阅
[权限策略](permission-policy.md)。

需要限制在工作目录内的文件和 shell 实现时，优先使用 `@may/coding-tools` 工厂。
其 shell 工具以 May 进程权限执行。需要执行隔离的应用应提供独立的沙盒
或远程执行后端。

## 测试边界

独立运行 `parse()` 和 `execute()`，使用 `AbortController` 和固定的执行环境，记录
`report()` 产生的进度。`{ left: 2, right: 3 }` 应返回 `{ value: 5 }`。
缺少数字或数字无效时必须校验失败；已经取消的信号必须停止执行。
随后通过配置的真实模型验证标准化输出进入下一次请求。

另请参阅[实现模型适配器](custom-model.md)和[自定义 UI](custom-ui.md)。

## 每次 Run 的动态工具目录

`MayOptions.toolSource`（也由 `AgentApplication`、`defineAgent()` 和
`MaybeCodeApplication` 透传）是可信宿主提供的同步 `() => Iterable<Tool>`。
它在静态 `tools` 之外追加工具，每次 `run()` 或 `continue()` 启动时仅调用一次，
同一 Run 的模型步骤复用该目录。重名在 Context 修改前失败。远程发现和刷新应在 Core
之外完成，再通过回调发布最新内存快照。

`ToolRegistry.snapshot()` 创建冻结的 Tool 外观对象，并深拷贝、冻结 schema。
同一 Run 的模型定义、调度、解析、权限和执行使用同一份快照；模型收到独立的
Schema 副本。目录更新仅影响下一次 Run。普通注册表查询及 `clone()` 保留
原始 Tool 身份，执行器收到 Run 外观对象：宿主元数据应放在 Tool
字段上。捕获的回调保持原始 `this`，闭包状态仍由调用方管理。
Schema 值必须支持 structured clone。

`Tool.permissionVersion` 是可选的宿主授权身份，不进入模型定义。Session 授权
同时绑定策略 `grantKey`、规范化的名称、描述、输入 Schema 和此版本。
定义或宿主身份变化，即使 `grantKey` 不变也需要重新批准；仅 Schema 属性顺序
变化不会失效。`revokeSessionGrant(key)` 撤销该键下全部版本，显式拒绝始终
优先。宿主适配器应将其他影响执行的字段以及端点/账户身份包含在版本中。

### 投影模型可见结果

`Tool.resultContent(output)` 可选地将成功输出投影为模型可见 `ContentPart[]`，替代
默认 JSON 内容；该回调也由 Run 快照捕获。`tool.completed.output` 为宿主保留原始
输出，`tool.completed.content` 保存模型可见投影，包括媒体和空数组。工具检查点
持久化这两个字段。Session 恢复和模型历史工具使用已保存的 `content`。旧记录缺少
该字段时返回明确的内容不可用提示；宿主仍可通过 Session 历史 API 读取原始输出。投影异常
作为工具失败处理。应验证不可信内容，避免投影仅宿主可见的元数据。

### 提供可信执行标签

`MayOptions.toolScope()` 可返回可信、仅宿主使用的字符串标签。Core 每次
Run 或继续执行时复制并冻结一次，作为 `ToolExecutionContext.scope` 传到工具及执行器和
权限边界，不放入模型定义或参数。禁止从工具输入推导这些标签。
`AgentApplication.toolScope` 接受标签记录并提供自身 Session 标识，MaybeCode 还
提供工作目录身份。标签用于交互路由，访问策略单独配置。

## 文件与进程安全

内置 `read` 保留原始行尾，默认允许读取硬链接；宿主也要禁止读取时可设
`read.allowHardLinks: false`。路径和符号链接的工作区边界校验仍然生效。
`write`、`edit` 默认拒绝硬链接，在目标同目录暂存完整 UTF-8 内容、同步并重命名；
提交前取消不会截断原文件。替换文本按字面值处理，包括 `$` 序列。替换会改变文件身份，
显式允许的硬链接会断开关联，其他别名保持原内容。它不能防御并发的不可信文件系统修改，
也不保证 Windows 目录级断电持久性。

shell 默认移除继承环境中含 `TOKEN`、`SECRET`、`PASSWORD`、`CREDENTIAL`、
`API_KEY`、`APIKEY` 的凭据类变量名。宿主可用 `inheritEnv: false` 禁用继承，
通过 `envAllowlist` / `envDenylist` 过滤，或通过 `env` 显式传入；值为 `undefined`
表示移除变量，拒绝列表也约束覆盖值。命令仍使用进程权限，能够读取获准访问的凭据文件。
超时或取消后的管道排空最多等待一秒；这不代表整个进程树已被确认终止。

`MayOptions.toolSettleTimeoutMs` 默认 2,000 ms。工具忽略取消且超时未结束时，
Run 以 `RUN_CHECKPOINT_FAILED` 失败，该运行时不可复用。应停止残留工作、检查外部
效果并完成 Session 核对后创建新运行时，不能把截止时间当作外部操作已经停止的证明。
