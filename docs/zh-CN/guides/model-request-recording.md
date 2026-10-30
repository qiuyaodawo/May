# 保存和检查模型请求

[English](../../en/guides/model-request-recording.md) | **简体中文**

## 启用记录

在 `Session.create()`、`Session.resume()`、`Session.fork()`、
`AgentApplication.open()` 或 `defineAgent()` 中设置
`requestRecording: "required"`，默认开启逻辑请求记录。独立选项
`providerBodyRecording: true` 开启 provider body 记录，默认值为 false；恢复或创建分支时再次提供该选项。
启用前配置好模型、runtime 和 Session store。FileSessionStore 会在 provider
发送请求之前按批次保存请求定义和引用，并完成文件同步。

```ts
const session = await Session.create({
  runtime,
  store,
  requestRecording: "required",
});
const run = await session.submit({ input: "What is 17 + 25?" });
await run.result;
const requests = await session.listModelRequests({ limit: 50 });
const attempts = await session.getModelRequest(requests[0]!.modelCallId);
```

MaybeCode 接受配置项 `apps.maybecode.requestRecording`。
MaybeClaw Gateway 的 `may` adapter 接受
`apps.maybeclaw.agents[].requestRecording`。两者均接受 `"off"` 和 `"required"`。
独立 MaybeClaw service 还接受 `MaybeClawOptions.requestRecording`。
以上配置位置均接受布尔选项 `providerBodyRecording`。

## 保存内容

版本为 1 的 `ModelRequestRecord` 包含 Hook 处理后的最终 Core 请求，
包括消息、system instructions、工具描述与 schema、metadata 和输出格式。
启用 `providerBodyRecording` 后还保存 adapter 生成的请求 body。记录包含 adapter 身份、endpoint 的 origin/path
及公开协议选项。显式参数和 adapter 默认值按发送内容保存；服务端默认值保持未指定。
endpoint 省略 URL 凭据、查询参数和 fragment。

内置传输使用的 Authorization、Cookie 和 API key 通过独立通道管理。
请求内容及工具 schema 保存在 Session 已有的存储中，包括内联媒体和 provider model state。
应用根据自己的数据规则保护和删除这些存储。远程媒体继续依赖外部资源。
识别到的 HTTP 资源 URL 字段记录在 `externalResourcePaths`；保存资源引用时省略 URL
凭据、查询参数和 fragment，并通过 `omittedPaths` 标明对应位置。
执行使用原始准备内容。这些标记说明完整重建请求时受到的限制。

## 事件与顺序

`model.request.defined` 使用 canonical JSON 和 SHA-256 保存按内容标识的值。
`model.request.prepared` 引用有顺序的消息、工具定义和 provider body 字段。
定义在引用之前写入；Session 内重复内容继续使用已有定义。

每次尝试依次保存准备记录、`model.attempt.started`，随后发送网络请求，
最后保存 `model.attempt.completed` 或 `model.attempt.failed`。
完成记录包含耗时及 provider 提供的生成用量。
失败记录包含取消状态、错误类别和可用的 HTTP 状态码。
这些请求事件省略 provider 的原始错误消息。

单份请求记录的 UTF-8 JSON 大小上限为 64 MiB。
记录失败会终止执行，需要重新打开 Session。
重试策略和自动压缩在请求 checkpoint 失败时终止。

## 重试与压缩

重试共享 `modelCallId`，各次尝试使用递增编号。
每次实际尝试都会保存逻辑请求，启用 body 记录后同时保存有效 body。内置 adapter 支持 DeepSeek、Kimi、Zhipu、
Anthropic Messages、Gemini、OpenAI Chat Completions 和 OpenAI Responses。
重试及能力验证包装器保留记录能力。

AgentApplication 为配置的模型增加统一记录通道，覆盖摘要和原生压缩调用。
摘要和原生压缩记录使用 `purpose: "compaction"` 及独立调用身份。
直接使用 Core 的应用，在自行创建摘要器或独立调用 `model.contextCompactor` 时，
可以使用 `withModelRequestRecording(model, sink)`。

## 查询与展示

Session 和 AgentApplication 提供 `listModelRequests({ afterSeq?, limit? })`
及 `getModelRequest(modelCallId)`。每页默认 50 项，最多 1000 项。
继续读取时，将上一页最后一项的 `seq` 作为 `afterSeq`。
`getModelRequest()` 返回一次逻辑调用保存的全部尝试。

WebUI 记录详情包含“模型请求”选项，支持通过 Session 历史提供的 assistant 和 Run 记录，
沿用已有的分页字段读取机制。MaybeClaw Gateway 对话视图提示管理员通过底层
Agent Session 查询，因为其对话记录使用独立表示。

## 恢复与分支

查询状态在保存尝试开始之前为 `prepared`，保存开始且缺少结果时为 `unknown`，
保存结果后为 `completed`、`failed` 或 `cancelled`。
保存开始记录后，网络请求仍可能尚未发送。读取请求记录不会发送请求或执行工具。

重新打开时验证定义摘要和引用。分支保留所选事件范围及其定义。
历史配置描述已保存调用；后续执行使用应用当前配置。
旧历史查询返回空的请求记录列表。
无法识别新增事件类型的旧版本读取器会明确拒绝读取这些历史。

## 自定义 adapter 和 runtime

adapter 声明 `supportsRequestRecording: true`，在完成请求转换后调用
`executeRecordedRequest(record, options.recordRequest, options.signal, execute)`。
辅助函数将 body 序列化一次，等待记录完成，随后将同一份序列化内容传给 `execute`。
原生非流式调用使用 `executeRecordedOperation`。
provider 显式构造公开记录，鉴权信息通过独立通道管理。

自定义 runtime 声明相同能力，将 Run/continue 的 `recordRequest` 通道转交模型调用，
并提供 `runId`、`step` 和 `modelCallId`。
包装器保留能力声明和 recorder 选项。
required 模式在调用前拒绝尚未声明支持的 runtime 和模型。

## 验证

执行 `pnpm build` 后，通过
`node --test packages/providers/test/request-recording.test.mjs` 检查请求历史。
通过 `node --test packages/providers/test/request-recording/integration/session.test.mjs`
运行真实 provider 场景。它使用配置中的默认模型，或者 `MAY_RECORDING_MODEL`，
验证请求保存、重新打开、分支、内容复用及后续执行。
