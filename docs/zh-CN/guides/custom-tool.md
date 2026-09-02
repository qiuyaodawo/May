# 自定义工具

[English](../../en/guides/custom-tool.md) | **简体中文**

May tool 是暴露给模型的一个命名 capability。`@may/core` 的 `Tool` 契约分离三个关注点：

- `inputSchema` 向模型描述调用；
- 可选 `parse()` 校验并转换不可信的模型输出；
- `execute()` 执行操作。

当前没有进程级全局 tool registry。每个 `May` 或 `AgentApplication` 接收自己的工具数组。

## 完整工具示例

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

打开 application 时注册：

```ts
const application = await AgentApplication.open({
  model,
  store,
  tools: [addTool],
  permissionPolicy,
});
```

`inputSchema` 会发给模型，但它不是 runtime validator。始终在 `parse()` 中校验；若单独
parser 不合适，也必须在 `execute()` 中校验。Permission policy 接收解析后的值。

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

工具名在 runtime 内必须唯一；`May` 拒绝重复。若 `AgentApplication` 启用可选
`session_history`，该名字由 application 保留。

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
