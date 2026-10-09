# 实现模型适配器

[English](../../en/guides/custom-model.md) | **简体中文**

模型适配器将 Provider 请求和响应转换为 `@may/core` 导出的 `Model` 接口。
接入新的 Provider 协议时，可以依据本文实现请求转换、流式响应、取消和错误处理。
Session 与产品行为由应用管理。

已经支持的 Provider 可以使用 `@may/providers` 的内置适配器。
新协议和本地协议演示可以实现 `Model`。

## 最小实现

以下本地文字转换器展示必需的流式协议，只执行大写转换，不调用外部模型服务。
容量限制为示例数值。在 ESM TypeScript 应用中创建 `uppercase-model.ts`，
将 `@may/core`、`@may/application` 和 `@may/session` 加入直接依赖。
工作区设置见[快速开始](../getting-started.md)。

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

在同一目录创建 `run.ts`，通过 `AgentApplication` 运行该协议：

```ts
import { AgentApplication } from "@may/application";
import { InMemorySessionStore } from "@may/session";
import { UppercaseModel } from "./uppercase-model.js";

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

编译两个文件，再执行生成的入口：

```sh
pnpm exec tsc --ignoreConfig --target es2022 --module nodenext --moduleResolution nodenext --outDir dist uppercase-model.ts run.ts
node dist/run.js
```

最终助手消息包含一个值为 `HELLO, MAY` 的文本部分。
这项检查覆盖本地协议和应用生命周期，Provider 集成需要真实账号和对该服务的请求。
`AgentApplication` 始终要求权限策略，包括没有工具调用的应用。

<a id="stream-协议"></a>

## 流式协议

每次 `stream()` 调用，适配器必须：

1. 发出零个或多个 `text.delta`、`reasoning.delta` 或 `retrying` 事件；
2. 发出恰好一个 `response.completed`，其中包含完整最终助手消息；
3. 在完成事件后结束迭代。

若没有完成事件就结束或发出两次完成事件，Core 会以 `ModelProtocolError` 使
Run 失败。流式增量用于实时呈现；`response.completed` 的完整消息是
持久化结果。

`ModelStreamOptions.signal` 是 Run 的取消边界。把它传给 Provider SDK 或 `fetch`，
解析长事件流时也要检查。取消信号必须终止请求。适配器或网络异常
可以正常抛出；Core 会发出 `run.failed` 并拒绝 Run `result`。

可选 `runId`、`step`、`modelCallId` 是关联值，在 Run 中由 May 填充；保持可选是为了
让适配器可以单独测试。

## 映射请求与响应

`ModelRequest` 包含：

- 标准化 `messages`，包括由 Context 指令合成的 `system` 消息；
- 与 Provider 无关的工具定义（`name`、`description`、`inputSchema`）；
- 可选应用元数据。

`ModelRequest`、它的 `messages`/`tools` 集合以及每个 `ToolDefinition` 都是
只读输入。适配器应把它们映射为新的、由 Provider 层拥有的请求对象；
不得原地修改、排序或 `splice()` May 的数组，也不得直接给消息或工具定义
添加 Provider 字段。同一 Context 快照可以用于重试、记录或其他包装器，
各个适配器管理自己的请求对象。

实际适配器负责校验 Provider 支持的内容。无法表示某种内容部分时应明确失败
（内置适配器使用 `UnsupportedContentError`）。Provider 工具调用
必须在最终助手消息中以标准化 `toolCalls` 返回；May 执行后在下一 Step
提供标准化工具消息。

Provider 续接数据可以作为 `modelState` 附加到助手消息。它应是
不透明、带命名空间和版本的值：Session 会持久化，Core 不解释，由所属
适配器在恢复后读取。

用量是可选的；Provider 提供时可在完成事件中返回。以下片段位于适配器的 `stream()` 中，
`message` 和 `providerUsage` 来自该服务的实际响应：

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

只报告 Provider 给出或能够可靠计算的 token 字段。

<a id="可选-capability"></a>

## 可选能力

适配器可以提供：

- `limits`，应用可用 `contextBudgetFromModel()` 转为 Context 容量预算；
- `contextCompactor`，用于 Provider 原生压缩。

Provider 原生压缩是可选能力。`@may/context` 通过
`ModelContextCompactionStrategy` 适配独立压缩器。
压缩器应当在 `ModelContextCompactionResult.usage` 中报告压缩请求自身的用量，
宿主根据实际用量计算费用。参阅
[自定义 Context](custom-context.md)。

<a id="注册可配置-adapter"></a>

## 注册可配置适配器

使用 May 模型配置的应用可以在 `@may/providers` 注册实例级工厂：

```ts
import { ProviderAdapterRegistry } from "@may/providers";

const registry = new ProviderAdapterRegistry().register("uppercase", {
  create(_selection) {
    return new UppercaseModel();
  },
});
```

模型配置的 `adapter` 必须为 `uppercase`。注册保存在当前实例；重复名称会被拒绝，
产品决定接受哪些注册表。

## 内置协议与重试行为

`RetryingModel` 保留服务端要求的 `Retry-After` 等待时间。超过 `maxDelayMs` 时，
返回原始错误。Responses 错误分别提供 `providerType` 和 `providerCode`。
Chat Completions 工具参数 JSON 无效时，产生协议错误。

Chat Completions 出现顶层 `error` 字段时，立即终止该内容块的处理，并在错误信息中
保留服务端的 `message`、`type` 和 `code`。流结束时继续保留此错误，
本次调用不会发出 `response.completed`。

<a id="adapter-检查清单"></a>

## 适配器检查清单

- 转发取消与 Provider 错误。
- 即使已经发出增量，也必须发出一个完整响应。
- 保留工具调用标识和所有受支持内容部分。
- 凭据只放 Provider 配置，不放消息或 `modelState`。
- 重试行为放在明确的适配器或包装器中，并在等待下一次尝试时发出 `retrying`。
- 在适配器边界测试无效事件流、取消、工具调用转换和不支持内容。

接下来阅读[自定义工具](custom-tool.md)和[构建 Agent](building-an-agent.md)。
