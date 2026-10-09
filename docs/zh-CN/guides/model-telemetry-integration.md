# 配置模型验证与执行诊断

[English](../../en/guides/model-telemetry-integration.md) | **简体中文**

本文用于在同一应用中组合模型能力验证、本地诊断和指标。需要 ESM TypeScript
项目、具有默认模型与 provider 凭据的 `may.config.json`，以及一次推理请求的
使用授权。项目需要安装 `@may/application`、`@may/config`、`@may/providers`
和 `@may/session`、`@may/plugin-observability`。

## 配置经过验证的模型与本地诊断

能力查询与模型创建共享 resolver。现有配置提供模型身份、provider 连接和能力声明。
observability 插件管理 processor，并在应用关闭时完成资源清理。

1. 将以下内容保存为与 `may.config.json` 同目录的 `main.ts`。
2. 使用项目的 TypeScript 构建编译，在该目录运行生成的 JavaScript。
   `./data` 保存 Session 日志和按日期管理的追踪文件。
3. 检查程序打印的能力快照、按 Session 查询的诊断、指标快照和导出队列诊断。

```ts
import { defineAgent } from "@may/application";
import { loadMayConfig } from "@may/config";
import { createBuiltinProviderAdapterRegistry, createModelCapabilityResolver,
  selectProviderModel } from "@may/providers";
import { createObservabilityPlugin, observabilityService } from "@may/plugin-observability";
import { FileSessionStore } from "@may/session/file-store";

const config = await loadMayConfig({ path: "./may.config.json" });
const selection = selectProviderModel(config);
const resolver = createModelCapabilityResolver();
const registry = createBuiltinProviderAdapterRegistry({ resolver });
const capabilities = await resolver.resolve(selection);
const model = registry.create(selection);
const definition = defineAgent({
  model,
  permissionPolicy: () => "deny",
  plugins: [createObservabilityPlugin({ dataDirectory: "./data", samplingRatio: 0.1 })],
  traceAttributes: {
    "may.configuration.version": "agent-policy-2",
    "may.context.policy_version": "context-policy-3",
    "may.budget.policy_version": "budget-policy-1",
  },
});
const application = await definition.open({ store: new FileSessionStore("./data/sessions") });
try {
  const run = await application.submit({ input: "Reply with a short greeting." });
  await run.result;
  const telemetry = application.getService(observabilityService);
  if (telemetry.diagnostics === undefined || telemetry.metrics === undefined) {
    throw new Error("The application requires local diagnostics and metrics");
  }
  console.log(capabilities);
  console.log(telemetry.diagnostics.getDiagnostics({ sessionId: application.sessionId, limit: 40 }));
  console.log(telemetry.metrics.getMetrics());
  console.log(telemetry.processor.getDiagnostics());
} finally {
  await application.close();
}
```

示例中的版本标识对应宿主管理的不可变策略。宿主保存策略定义和 evaluator 证据。
能力信息与验证记录分别提供。刷新 resolver 查询 metadata，不发送演示 prompt，
不消耗模型 token。
Trace ID、时间、provider 输出和用量取决于实际请求。`samplingRatio: 0.1` 时，
本地诊断仍观察全部本地 span，仅选中的 trace 进入文件导出。

## 能力与请求判定

每个字段提供已知值、明确的不支持状态或者未知状态。model、adapter 与 connection
共同限制有效能力；adapter 的传输能力无法证明 model 支持相同功能。用户模型声明
在 model 层优先，connection 声明可以继续限制模型。消费者可以读取 `layers`、
`version`、时间、声明来源与查询诊断。

内置模型在发送推理请求前验证内容类型与来源、已声明的图片和附件限制、可用的 MIME
信息、reasoning effort、参数 schema 和输出格式限制。宿主可以提供
`estimatedInputTokens` 与媒体 metadata，验证需要外部测量的信息；未知测量结果
持续保留。`options.unknownCapabilityPolicy: "require-known"` 要求已知支持；
默认的 `allow` 允许未知字段，并提供验证问题。

`ModelRequest.responseFormat` 选择 JSON 或者具有名称的 JSON Schema 输出。
OpenAI Responses 与 Chat Completions 发送原生格式字段，不支持的传输方式在发送
前拒绝请求。Ajv 验证支持的 schema dialect 与最终结果。schema 验证失败会终止
请求，模型、参数、schema 和用户内容保持原值。自定义 registry 可以通过
`validateRequests` 或者 `createCapabilityValidatedModel` 启用验证。

provider 已返回完整响应时，`ModelResponseValidationError` 保留响应完成状态和
已知用量。输出校验失败同样计入预算、费用与遥测；无效输出不会进入 Context 或
触发工具执行。缺失用量持续显示为未知。

resolver 支持缓存 TTL、数量限制、并发查询去重和明确刷新。验证记录保存实际观察到
的请求参数与长度受限的 connection identity，记录不会自动扩大能力声明。参见
[配置参考](../reference/configuration.md)。

## 用量、费用与预算

Usage 区分 cached read、cached write、reasoning 和其他项目，同时保留包含关系
与完整性。Run budget 与 shared budget 使用同一个版本化计价结果。估算费用与
provider 上报金额分别保留 `kind`、币种、来源和完整性。宿主配置当前已经确认的
价格，组件不会自动查询或者编造价格。缺失数量、未知包含关系和缺失费率持续可见。

`maxCostUsd` 要求完整的 USD 计价。provider 可能在接受请求后才上报用量，响应后的
预算检查无法撤销该请求产生的费用。参见[运行预算](run-budgets.md)和
[共享预算](coordination-resources.md)。

## 任务、继续执行与远程执行

`TelemetryCorrelation` 包含 `version: 1`、task、coordination、dispatch、
scheduler execution、先前 Run 身份与可选的父级 trace。组件验证标识，拒绝内容
和凭据。Coordination 向 ApplicationAgent 与 May adapter 传递关联信息。远程
worker 在执行前验证关联信息，并从业务请求标识计算中排除关联信息。启用遥测后，
Scheduler 提供关联信息，宿主 dispatcher 继续传递信息并管理持久化去重。
Session 继续执行创建新的 Run，并通过 `may.run.resumed_from` 记录先前 Run，
重新打开 Session 后同样适用。

一个逻辑 `may.model.call` 包含独立的 `may.model.attempt` 记录。首次内容与首次
文本分别计时，没有输出时保留缺失状态。取消、协议失败与完成状态独立于输出存在性。
并行任务分别显示自身耗时和身份。

## 诊断、指标与验收

本地诊断在数量与保留时间限制内保存全部观察到的 span，包含未被选中进行远程导出
的 span。查询可以按 task、Session、Run 或 trace 身份过滤并分页。导出队列具有
容量限制、超时与失败和丢弃数量。指标独立于 trace 采样，记录 Run、call、attempt、
工具、token、费用和延迟，并限制标签与 series 数量。官方 OpenTelemetry adapter
通过 OTLP HTTP 导出 traces 与 metrics。参见[可观测性](observability.md)。

宿主通过 `recordAssessment` 提供 evaluator 与版本、task 身份、`passed`、
`failed` 或 `inconclusive`、配置版本和证据引用。诊断与证据访问由宿主授权。
执行结果与任务验收分别记录。

MaybeCode 显示模型能力与活动 Session 的诊断。MaybeClaw 通过现有管理命令提供
经过认证的模型检查与选中会话诊断。`createTelemetryPanel` 提供共享显示组件，
保留父级身份、独立耗时与记录保留范围。参见[共享 Web UI](web-ui.md)。

## 验证命令

在仓库根目录使用 `package.json` 声明的 pnpm 版本。以下命令检查本地 package
和文档：

```powershell
pnpm build
pnpm test
pnpm docs:check
pnpm test:package:plugin
pnpm test:package:scheduler
```

真实 provider 检查需要已配置默认模型的凭据，并且需要授权相应用量：

```powershell
pnpm test:integration:model-telemetry
```

live integration 命令使用宿主配置的默认模型与 provider 配额，发送一次推理请求。
OpenAI 传输同时验证原生 JSON Schema 输出。命令检查实际用量、能力版本、attempt
父级关系和独立指标。报告与 Session 历史保存在被忽略的
`review/model-telemetry-live/`。本地协议、SQLite、文件与进程测试无需外部模型账户。
