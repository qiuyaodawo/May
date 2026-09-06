# 自定义工具

[English](../../en/guides/custom-tool.md) | **简体中文**

May tool 是暴露给模型的一个命名 capability。`@may/core` 的 `Tool` 契约分离三个关注点：

- `inputSchema` 向模型描述调用；
- 可选 `parse()` 校验并转换不可信的模型输出；
- `execute()` 执行操作。

`@may/core` 提供实例级 `ToolRegistry`，用于显式组合与查询工具；它不是进程级全局
service locator。`May`、`AgentApplication` 和 `AgentDefinition` 都接受
`Iterable<Tool>`，所以可以传 registry、数组或其他 iterable。

## 完整工具示例

```ts
import { ToolRegistry, type Tool } from "@may/core";

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

与其他 capability 组合，再把集合捕获到 Agent definition 中：

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

`inputSchema` 会发给模型，但它不是 runtime validator。始终在 `parse()` 中校验；若单独
parser 不合适，也必须在 `execute()` 中校验。Permission policy 接收解析后的值。

## 使用 `ToolRegistry` 组合工具

Registry 保留注册顺序，并在实例内保证名字唯一：

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
| `new ToolRegistry(tools?)` | 从一个 iterable 注册初始工具 |
| `register(tool)` | 原子注册单个工具并返回同一 registry |
| `registerAll(tools)` | 原子注册整批工具并返回同一 registry |
| `size`、`has(name)` | 查询数量或名字是否存在 |
| `get(name)` | 返回工具或 `undefined` |
| `require(name)` | 返回工具；缺失时抛出 `ToolNotFoundError` |
| `names()`、`values()` | 返回注册顺序的数组快照 |
| `definitions()` | 返回不含 parser/executor callback 的模型侧定义快照 |
| `clone()` | 创建可独立继续注册的新 registry |
| `[Symbol.iterator]()` | 按注册顺序迭代工具 |
| `ToolRegistry.compose(...sources)` | 按 source 顺序组合多个 iterable |

`registerAll()` 会先完整消费并校验输入。若工具无效、与现有名字重复，或同一批输入中
出现重名，它会抛出 `TypeError` 或 `DuplicateToolNameError`，且**不注册该批中的任何
工具**。`register()` 具有相同的单项原子性。`compose()` 遇到重复名字也会失败，而不是
静默覆盖。`DuplicateToolNameError` 是带 `code: "DUPLICATE_TOOL_NAME"` 的 `MayError`，
其 `toolName` 属性保存冲突名称。

`names()`、`values()` 和 `definitions()` 返回新数组；`clone()` 不共享可变 registry
映射。Registry 仍返回注册时的原始 `Tool` 对象身份，以便调用方继续使用基于
`WeakMap<Tool, ...>` 的 metadata；它不会用 wrapper 替换工具。

注册时，registry 会保存 descriptor 的值或引用：`name`、`description`、
`inputSchema` 引用、`parse` 和 `execute`。TypeScript 的 `Tool` 契约将这些字段声明为
`readonly`。若 JavaScript 或 type assertion 在注册后替换其中任意字段，之后通过
`get()`/`require()`/`values()` 取出工具、迭代、clone/compose 或生成 definition 时会
抛出 `TypeError`，而不是在旧名称/新实现之间产生不一致。
`inputSchema` 只比较对象引用，并不会被深度冻结；因此调用方仍必须把 schema 及已注册
Tool 的 descriptor 视为稳定值。工具的其他内部运行状态可以按产品 ownership 模型
变化。

`May` 在构造时快照传入 iterable 的成员，之后向源 registry 注册工具不会改变该
runtime。`defineAgent()` 也在创建 definition 时快照工具成员，之后每次 `open()` 都使用
同一组工具。直接 `AgentApplication.open()` 会在打开期间快照工具。若产品需要不同
capability 集合，应显式创建新的 runtime 或 definition。

## Execution Context

每次调用都会收到 `ToolExecutionContext`：

- `runId`、`step`、`toolCallId` 用于关联事件；
- `idempotencyKey` 对该调用保持稳定，外部 API 支持去重时应使用它；
- `signal` 与所属 Run 一起取消操作；
- `report()` 发出实时 `output.delta` 或结构化 `progress`。

Progress 不是持久化 Session history。`execute()` 必须返回完整结果，不能依赖 UI 保存
每个 delta。

长时间任务应把 `signal` 传给每个可取消依赖，并在不可取消阶段之间检查：

```ts
async execute(input, context) {
  const response = await fetch(input.url, { signal: context.signal });
  context.signal.throwIfAborted();
  return { status: response.status, body: await response.text() };
}
```

若副作用可能在取消前已经 commit，工具必须自行定义恢复或幂等行为。May 无法回滚
外部副作用。

## 失败语义

校验错误或普通执行错误会成为 `tool.failed` 事件和错误 tool message，模型可在下一
Step 观察并恢复。只有继续 Run 会不安全时（例如授权或持久化边界损坏）才抛出
`FatalToolExecutionError`。

被 abort 的 Run 不等同于普通工具失败。Signal abort 后应停止 progress 并尽快退出。
Core 会为完成前被取消的调用记录终结结果，避免恢复后的 history 出现无匹配结果的
tool call。

工具名在 runtime 内必须唯一；`May` 构造内部 registry，因此重名会抛出
`DuplicateToolNameError`。若 `AgentApplication` 启用可选 `session_history`，该名字由
application 保留。

Core 默认串行调度。只有同一模型响应选择的每个工具都可安全并发、且结果按调用顺序
仍有意义时，才使用 `parallelToolScheduler`。

## 安全边界

工具是可执行应用代码，不是 sandbox：

- 把模型参数视为恶意输入；
- 限制输入、输出、运行时间、重试与资源使用；
- 强制 workspace 边界时规范化文件路径并防御 link；
- 不要返回 credential 或敏感环境数据，因为工具结果对模型可见且会持久化；
- 网络和数据库使用最小权限 client；
- 用户授权放在独立 permission policy 中。

审批控制 capability 是否可以运行，但不能限制被批准后进程能访问什么。参阅
[权限策略](permission-policy.md)。

对于 workspace-safe 的文件和 shell 实现，优先使用 `@may/coding-tools` factory。
其 shell 工具以 May 进程权限执行，并且明确**不是** sandbox。

## 测试边界

先脱离模型测试 `parse()` 和 `execute()`：使用 `AbortController`、固定 execution
context 并捕获 `report()`。然后增加一个 runtime 测试，证明标准化输出会返回模型。
每个工具无需重复测试 provider 行为。

另请参阅[自定义模型 Adapter](custom-model.md)和[自定义 UI](custom-ui.md)。

## 每次 Run 的动态工具目录

`MayOptions.toolSource`（也由 `AgentApplication`、`defineAgent()` 和
`MaybeCodeApplication` 透传）是可信宿主提供的同步 `() => Iterable<Tool>`。
它在静态 `tools` 之外追加工具，每次 `run()` 或 `continue()` 启动时仅调用一次，
而不是每个模型 step 调用。重名在 Context 修改前失败。远程发现/刷新应在 Core
之外完成，再通过回调发布最新内存快照。

`ToolRegistry.snapshot()` 创建冻结的 Tool 外观对象，并深拷贝、冻结 schema。
同一 Run 的模型定义、调度、解析、权限和执行使用同一份快照；模型收到独立的
schema 副本。目录更新仅影响下一次 Run。普通 registry 查询/`clone()` 仍保留
原始 Tool 身份，但 executor 收到的是 Run 外观对象：宿主元数据应放在 Tool
字段上，而不应只依赖对象身份 WeakMap。捕获的回调保持原始 `this`；这不是沙箱，
也不会深拷贝任意闭包状态。Schema 值必须支持 structured clone。

`Tool.permissionVersion` 是可选的宿主授权身份，不进入模型定义。Session grant
现在同时绑定策略 `grantKey`、规范化的名称、描述、输入 schema 和此版本。
定义或宿主身份变化，即使 grantKey 不变也需要重新批准；仅 schema 属性顺序
变化不会失效。`revokeSessionGrant(key)` 撤销该 key 下全部版本，显式 deny 始终
优先。宿主适配器应将其他影响执行的字段以及端点/账户身份包含在版本中。

`Tool.resultContent(output)` 可选地将成功输出投影为模型可见 `ContentPart[]`，替代
默认 JSON 块；该回调也由 Run 快照捕获。`tool.completed` 保留原始输出，投影异常
作为工具失败处理。应验证不可信内容，避免投影仅宿主可见的元数据。
