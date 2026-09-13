# 自定义模型 Adapter

[English](../../en/guides/custom-model.md) | **简体中文**

May model adapter 把某个 provider 协议转换为 `@may/core` 的 provider-neutral `Model`
契约。它不应管理 Session、权限提示、UI 状态或产品指令。

Provider 已被支持时优先使用 `@may/providers` 的内置 adapter。集成新协议或为测试创建
确定性模型时再实现 `Model`。

## 最小实现

以下 adapter 是本地且确定性的，但它是完整 `Model`，可以直接放入应用：

```ts
import type {
  AssistantMessage,
  Model,
  ModelEvent,
  ModelLimits,
  ModelRequest,
  ModelStreamOptions,
} from "@may/core";

export class UppercaseModel implements Model {
  readonly limits: ModelLimits = {
    contextWindowTokens: 4_096,
    maxOutputTokens: 512,
  };

  async *stream(
    request: ModelRequest,
    options: ModelStreamOptions,
  ): AsyncIterable<ModelEvent> {
    options.signal.throwIfAborted();

    const text = lastUserText(request).toUpperCase();
    if (text !== "") {
      yield { type: "text.delta", delta: text };
    }

    options.signal.throwIfAborted();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text }],
    };
    yield { type: "response.completed", message };
  }
}

function lastUserText(request: ModelRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index--) {
    const message = request.messages[index];
    if (message?.role !== "user") continue;
    return message.content
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("");
  }
  return "";
}
```

可直接把它提供给 headless application：

```ts
import { AgentApplication } from "@may/application";
import { InMemorySessionStore } from "@may/session";

const application = await AgentApplication.open({
  model: new UppercaseModel(),
  store: new InMemorySessionStore(),
  permissionPolicy: () => "deny",
});

try {
  const run = await application.submit({ input: "Hello, May" });
  console.log((await run.result).message);
} finally {
  await application.close();
}
```

即使这个模型从不调用工具，`AgentApplication` 仍要求 permission policy。

## Stream 协议

每次 `stream()` 调用，adapter 必须：

1. 发出零个或多个 `text.delta`、`reasoning.delta` 或 `retrying` 事件；
2. 发出恰好一个 `response.completed`，其中包含完整最终 assistant message；
3. 在 completion event 后结束 iterable。

若没有 completion 就结束或发出两次 completion，Core 会以 `ModelProtocolError` 使
Run 失败。Streaming delta 是实时呈现数据；`response.completed` 的完整消息才是
持久化结果。

`ModelStreamOptions.signal` 是 Run 的取消边界。把它传给 provider SDK 或 `fetch`，
解析长 stream 时也要检查。不能把 abort 转成成功 completion。Adapter/network 异常
可以正常抛出；Core 会发出 `run.failed` 并 reject Run result。

可选 `runId`、`step`、`modelCallId` 是关联值，在 Run 中由 May 填充；保持可选是为了
让 adapter 可以单独测试。

## 映射请求与响应

`ModelRequest` 包含：

- 标准化 `messages`，包括由 Context instructions 合成的 system message；
- provider-neutral 工具定义（`name`、`description`、`inputSchema`）；
- 可选 application metadata。

`ModelRequest`、它的 `messages`/`tools` collection 以及每个 `ToolDefinition` 都是
readonly adapter 输入。Adapter 应把它们映射为新的、由 provider 层拥有的请求对象；
不得原地修改、排序或 `splice()` May 的数组，也不得直接给 message/tool definition
添加 provider 字段。这样同一 Context snapshot 才能被重试、记录或交给其他 wrapper，
而不会受到 adapter 的隐藏副作用。

真实 adapter 负责校验 provider 支持的内容。无法表示某种 content part 时应明确失败
（内置 adapter 使用 `UnsupportedContentError`），而不是静默丢弃。Provider tool call
必须在最终 assistant message 中以标准化 `toolCalls` 返回；May 执行后在下一 Step
提供标准化 tool message。

Provider continuation 数据可以作为 `modelState` 附加到 assistant message。它应是
不透明、带 namespace 和 version 的值：Session 会持久化，Core 不解释，只有 owning
adapter 在恢复后读取。

Usage 是可选的；provider 提供时可在 completion 中返回：

```ts
yield {
  type: "response.completed",
  message,
  usage: {
    inputTokens: providerUsage.promptTokens,
    outputTokens: providerUsage.completionTokens,
    totalTokens: providerUsage.totalTokens,
  },
};
```

不要编造 token。只报告 provider 给出或能够可靠计算的字段。

## 可选 Capability

Adapter 可以暴露：

- `limits`，应用可用 `contextBudgetFromModel()` 转为 Context budget；
- `contextCompactor`，用于 provider 原生压缩。

Provider-native compaction 是可选能力。`@may/context` 通过
`ModelContextCompactionStrategy` 适配它，不应塞入普通 `stream()` 实现。参阅
[自定义 Context](custom-context.md)。

## 注册可配置 Adapter

使用 May model profile 的应用可以在 `@may/providers` 注册实例级 factory：

```ts
import { ProviderAdapterRegistry } from "@may/providers";

const registry = new ProviderAdapterRegistry().register("uppercase", {
  create(_selection) {
    return new UppercaseModel();
  },
});
```

配置 profile 的 `adapter` 必须为 `uppercase`。注册不是全局的；重复名称会被拒绝，
产品决定接受哪些 registry。

## Adapter 检查清单

- 转发取消与 provider error。
- 即使已经发出 delta，也必须发出一个完整 response。
- 保留 tool-call ID 和所有受支持 content part。
- Credential 只放 provider 配置，不放 message 或 `modelState`。
- 重试行为放在明确的 adapter/wrapper 中，并在等待下一次尝试时发出 `retrying`。
- 在 adapter 边界测试 malformed stream、取消、tool-call 转换和不支持内容。

接下来阅读[自定义工具](custom-tool.md)和[构建 Agent](building-an-agent.md)。

Retry-After 不会被截短以适应 `maxDelayMs`。服务端要求的等待超过配置退避上限时，
RetryingModel 返回原始错误，而不是提前重试。Responses 错误分别提供 `providerType`
和 `providerCode`；Chat Completions 工具参数 JSON 无效时产生协议错误，不作为字符串参数下传。
