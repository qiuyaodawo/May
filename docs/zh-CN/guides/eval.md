# 评估 Agent 任务结果

[English](../../en/guides/eval.md) | **简体中文**

使用 `@may/eval`，可以让不同模型、提示词、工具、权限或 Context 配置执行相同
任务，并检查实际结果。每次执行分别保存执行状态、验收证据、基础设施状态、
人工协助和资源用量。

本指南面向已经定义验收要求的宿主开发者，从仓库中可以执行的命令案例开始，
随后介绍如何注册真实 Agent 和验收程序。在仓库执行命令时，使用 Node.js 22.16
或更高版本，以及 `package.json` 声明的 pnpm 版本。

## 执行可信 suite

仓库专用 CLI 加载导出 `experiment` 和 `registry` 的 JavaScript 文件。
导入文件会以宿主文件、进程和网络权限执行代码，只能加载可信文件。
内置案例使用实际文件和 Node.js 进程，不需要模型凭据。

1. 在仓库根目录通过 `pnpm install --frozen-lockfile` 安装依赖，执行 `pnpm build`。
2. 验证内置案例配置：

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
```

   默认案例保持原配置时，命令输出 `Validated file-artifact`。
   配置验证不启动任务。
3. 执行实验并检查报告：

```powershell
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
```

   该实验计划执行两次，写入包含大写消息的 `result.json`，随后独立检查文件。
   检查两次执行的执行状态、验收状态和基础设施状态。执行 ID 和耗时会变化。
   实验目录保存 `report.json` 和 `report.md`。
4. 保留报告和证据供审查。新执行不能复用已有实验 ID，重复案例时将
   `MAY_EVAL_EXAMPLE_ID` 设置为新的 ID。继续中断实验时，使用
   [重启流程](#重启与重新执行)。

`--output` 指定存储根目录，每个实验使用以实验 ID 命名的目录。存储根目录
必须位于候选工作区之外。执行或验收失败时仍然保存报告，CLI 返回非零状态。
SIGINT 和 SIGTERM 请求取消，并保留已经开始的执行记录。

内置 file-artifact 案例通过真实命令写入和检查文件，验证评估生命周期及 CLI。
评估 Agent 完成任务的能力时，通过 Application 或 Coordination 适配器接入
宿主配置的模型和权限策略。

宿主可以通过以下函数运行已经注册的实验，参数包括 `EvalExperiment`、匹配的
`EvalRegistry`、宿主管理的存储目录和取消信号：

```ts
import { EvalRunner, type EvalExperiment, type EvalRegistry } from "@may/eval";
import { FileEvalStore } from "@may/eval/file-store";

export async function evaluateExperiment(
  experiment: EvalExperiment,
  registry: EvalRegistry,
  directory: string,
  signal: AbortSignal,
) {
  const runner = new EvalRunner({
    registry,
    store: new FileEvalStore({ directory }),
    signal,
    onTrial: state => console.log(state.trial.id, state.taskVerdict),
  });
  runner.validate(experiment);
  return await runner.run(experiment);
}
```

## 案例、配置与 registry

`EvalCase` 定义案例，包含 `id`、`version`、`description`、`input`、
`environment`、`evaluators` 和 `limits`。组件引用包含 `id`、`version` 和可选
JSON `options`。至少一个验收程序必须设置 `required`。
`requiredCapabilities` 声明需要的环境能力；`evaluateAfterLimit` 允许达到
执行限制后，在确认执行已经终止的情况下继续验收。

`EvalVariant` 定义待评估配置，包含执行组件和 JSON `configuration` 快照，
可以设置 `runBudget` 和人工协助标记 `assisted`。凭据保存在宿主配置中，
快照保存配置引用、模型名称、提示词版本和工具版本。

`EvalExperiment` 定义实验 ID、案例、待评估配置、重复次数、并发数量、`seed`
和证据规则。`EvalRegistry` 保存显式注册的环境、执行和验收组件。
执行前核查组件的准确版本、预算、超时、ID、必需验收程序及环境能力。

使用 `registerEnvironment()`、`registerExecution()` 和 `registerEvaluator()`
注册组件。宿主回调及其引用的配置属于可信代码。影响行为的设置保存在组件
`options` 或配置快照中，行为变化时更新组件版本。

执行前保存完整计划和配置指纹。每个 `case × variant × repetition` 组合
获得独立的 trial ID。`seed` 决定不同配置交错执行的顺序，provider 的随机行为
由其自身配置决定。

## 环境生命周期

`EvalEnvironmentAdapter.prepare()` 创建独立资源并返回 `PreparedEnvironment`。
`executionTarget` 提供候选执行需要的资源。全部 Agent 工作终止后，`freeze()`
返回固定的 `EvaluationTarget`。`dispose()` 清理环境拥有的资源，并允许重复调用。
重启恢复使用环境提供的可选 `recover()`。

环境能力包括 `independentResources`、`filesystemIsolation`、`processIsolation`、
`networkIsolation`、`credentialIsolation` 和可选 `protectedEvaluationResources`。
本地目录副本提供独立文件，执行进程仍具有宿主权限，可以访问验收代码、答案和
凭据。需要限制这些访问的案例必须声明相应能力，并使用宿主提供的隔离环境。
宿主负责能力声明，通过环境安装和隔离测试核查实际行为。

验收程序、预期答案、存储文件和评分凭据保存在候选工作区之外。服务需要独立
数据库、命名空间或账户。没有独立资源的环境拒绝并发执行，进程、网络和凭据
访问限制由环境负责。

`createLocalDirectoryEnvironment({ sourceDirectory, rootDirectory, id?, version?,
maxFiles?, maxBytes?, excludeNames? })` 创建内置目录适配器。每个快照默认最多
10,000 个文件、67,108,864 字节。按文件名称排除 `.git`、`node_modules`、`.env`、
`.env.*` 和 `.eval-results`，宿主可以增加项目需要的排除项。基线和固定快照
继续保留供后续验收，清理时删除活动的候选目录。宿主管理快照及记录的保留时间。

## 执行与取消

每个 trial 按 `prepare → execute → freeze → evaluate → cleanup` 顺序执行。
各阶段记录开始、结束、耗时和结果，在阶段转换前保存记录。每个阶段具有独立
超时，执行阶段还接收 `RunBudget`。

执行适配器创建具有 `execute()`、`cancel()` 和 `close()` 的 `EvalExecution`，
必须报告 `terminationConfirmed`。超时或取消时，评估组件请求终止、等待确认
并保存证据。无法确认时记录 `termination-unconfirmed`，阻止可能修改仍被
Agent 使用的资源的验收。清理错误与原始错误分别保留。

进行中的固定快照和验收操作必须结束后，才能清理环境。验收程序无法确认终止
时保留环境并停止后续验收，等待超过清理限制后，资源继续供宿主检查。

`createCommandExecutionAdapter({ id, version, command, confirmTermination?,
validate? })` 使用明确的可执行文件、参数数组和绝对工作目录。
`confirmTermination({ context, command, outcome, signal })` 由宿主核查任务
启动的全部进程是否已经终止。`processTerminationConfirmed` 只说明直接启动的
进程已经终止，正常退出后仍可能存在后代进程。未提供核查回调时，结果包含
`terminationConfirmed: false`，并保留活动目录供宿主检查。

`createNodeCommandExecutionAdapter({ id, version, command, validate? })` 执行
可信 Node.js 程序。`command` 返回绝对 `script` 和 `cwd`，以及可选 `args`、
`env` 和 `maxOutputBytes`。组件启用 Node 的 `--permission` 模式，允许读取
脚本和工作目录、写入工作目录，禁止子进程、worker、native addon 和 WASI，
并拒绝覆盖 `NODE_OPTIONS` 和 `NODE_PATH`。受控程序进程终止后可以确认执行
终止。该模式用于可信代码，强制进程和凭据隔离仍需要相应环境能力。

Application 适配器消费事件并保存 Session、Run ID；Coordination 适配器等待
任务图并保存协作及节点 ID。`yielded`、等待和恢复状态需要宿主明确处理。
权限由宿主提供，固定策略审批和真实人工审批都会记录。交互入口不可用时以
明确结果终止，人工审批等待时间单独计量。

`@may/eval/application` 导出
`createApplicationExecutionAdapter({ version, open, input?, approvals?,
continueAfterYield?, maxContinuations? })`。`open({ context, tracer, budget })`
返回新的 `AgentApplication`。向 Application 提供 `tracer`，模型使用
`budget.wrapModel(realModel)`，工具使用 `budget.wrapTools(realTools)` 或
`budget.wrapToolExecutor(realExecutor)`。预算覆盖全部输入及继续执行。
未提供自定义 `input()` 映射时，案例消息必须全部具有 `role: "user"`。
默认最多继续执行 32 次。输出通过 `text` 保存最终文本，通过 `json` 数组保存
结构化数据，没有对应内容时省略字段。

`@may/eval/coordination` 导出
`createCoordinationExecutionAdapter({ version, create, outputTaskId?, approvals? })`。
`create({ context, tracer, budget })` 创建新的 `CoordinationRuntime`，所有模型
及工具都使用同一个预算包装，限制覆盖完整任务图。未绑定预算时拒绝执行。
`outputTaskId` 指定返回最终文本的任务，省略时返回全部任务 ID、状态和最终文本。

审批处理器提供 `decide(request, signal)`。人工决定使用 `assisted: true`，
固定宿主策略记为自动执行。待评估配置可以显式设置 `assisted: true`，记录
到人工介入时报告也会标记人工协助。适配器处理审批及计量等待时间，遥测证据
保存请求和 Session ID、请求及决定时间、决定和状态，省略工具输入。

## 重启与重新执行

使用原始文件和实验目录恢复内置案例：

```powershell
pnpm eval resume --suite apps/eval/examples/suite.mjs --experiment .eval-results/file-artifact
```

创建实验时设置了 `MAY_EVAL_EXAMPLE_ID`，恢复时保持相同值。

`resume()` 保留已经完成的 trial，只启动尚未开始的 trial。已经开始却没有最终
状态的记录标记为 `interrupted`。执行已经开始时，执行适配器的可选 `recover()`
必须确认执行已经终止，随后环境的 `recover()` 才能清理资源。无法确认时记录
`termination-unconfirmed`，并保留目录。尚未开始的 trial 使用独立资源。
注册表版本和实验指纹必须符合已经接受的计划。

实验包含内容处理回调时，向 `resume(experimentId, experiment)`、
`retry(experimentId, trialId, experiment)` 和
`evaluateTrial(experimentId, trialId, evaluatorId, experiment)` 传入原始可信实验。
人工评分使用 `grade(experimentId, trialId, evaluatorId, result, experiment)`
恢复相同回调，CLI 通过 `--suite` 提供原实验，`grade` 同样支持该参数。
回调的 ID 和版本会保存，缺少所需回调时拒绝继续执行。

显式 `retry()` 创建新的 trial，通过 `retryOf` 关联原始记录，保留原始结果。
任务不会自动重新执行。provider 按照配置策略重试，计量包含每次请求尝试。
存储损坏或格式版本不兼容时立即产生错误。

## 验收与评分

`EvalEvaluator` 接收固定目标、执行结果、案例、配置、`options`、证据写入接口
及事件接口，返回结果、检查、可选分数和证据引用。内置验收支持命令、JSON
Schema、文件修改及组合检查。命令明确可执行文件、参数、工作目录和超时，
文件检查验证允许修改的范围和内容要求。成熟文件格式使用对应第三方库读取。

内置创建函数包括：

- `createCommandEvaluator({ id, version, command, confirmTermination?, expectedExitCode?, validate? })`
- `createNodeCommandEvaluator({ id, version, command, expectedExitCode?, validate? })`
- `createJsonSchemaEvaluator({ schema, read?, id?, version? })`
- `createFileChangesEvaluator({ allowedPaths, requirements?, id?, version? })`
- `createCompositeEvaluator({ id, version, evaluators })`
- `createHumanEvaluator(id?, version?)`

Schema 检查默认读取 `execution.output`，`read()` 可以提供其他数据。文件要求
支持存在状态、准确文本、包含文本和 SHA-256，检查固定快照。允许路径是准确的
规范化相对路径，组合检查按照注册顺序执行。

通用命令验收与通用执行适配器具有相同的全部进程终止确认要求，缺少确认时
记录 `termination-unconfirmed`，验收为 `inconclusive`。Node 验收使用相同的
Node permission 模式及绝对脚本和工作目录配置。

文件检查重新计算固定目录的完整清单，比较路径、字节数和 SHA-256，随后检查
内容要求。快照改变时拒绝验收。`readEvaluationFile()` 要求规范化相对路径和
固定目录内的普通文件，拒绝符号链接，并在读取前后检查字节限制。默认最多
1,048,576 字节，宿主可以显式提供其他正数限制。

必需结果决定 `taskVerdict`：任一必需检查失败得到 `failed`，全部通过得到
`passed`，其他情况为 `inconclusive`。可选检查保留证据和分数，不改变这个
结果。案例可以将分数阈值加入验收要求。

人工审核返回 `awaiting-review`，后续评分增加验收修订并保留早期修订。
使用 JSON `EvaluationResult` 提交评分：

```powershell
pnpm eval grade --experiment .eval-results/file-artifact --trial <trialId> --evaluator <evaluatorId> --result ./review-result.json
```

实验声明自定义内容处理回调时增加 `--suite ./suite.mjs`。

`createModelEvaluator({ version, modelId, promptVersion, rules, model, runBudget,
input?, responseFormat?, scoreThresholds?, id? })` 调用真实 May 模型评分。宿主
提供模型和规则，组件保存模型 ID、提示词版本、规则、schema、原始结果和证据，
候选内容作为待评分数据。分数范围为零至一，无效输出、检查结果不一致或请求
失败产生 `inconclusive`。候选 Agent 和评分模型分别计量。

`scoreThresholds` 可以在注册的验收程序或案例引用 `options` 中声明，范围为
`[0, 1]`。所需分数缺失时为 `inconclusive`，低于阈值时相应检查为 `failed`，
未声明阈值的分数不自动参与判定。

## 结果与指标

每个 trial 分别保存 `executionStatus`、`taskVerdict` 和 `infrastructureStatus`。
达到限制后的结果仍可能通过验收，执行状态继续保存 `limited`。基础设施错误
保留失败阶段和错误代码，原因未知时保存 `unknown`。

组件记录耗时、审批等待、模型调用、provider 请求尝试、重试等待、工具调用及
错误、Context 压缩、人工介入、token 和费用。稳定事件 ID 防止重复计量，用量
或价格缺失时保存原因。`UsageCost` 包含完整性和宿主提供的价格版本，评分模型
具有独立指标总计。

Application 和 Coordination 适配器传递 Core 遥测关联信息，连接 trial 证据与
Session、Run、协作和 trace ID。评分修订可以转换为 Observability
`TaskAssessment`，`EvalStore` 保存实验的持久记录。`DiagnosticsStore` 提供
关联查询，并管理自己的保留限制。

## 证据与存储

`FileEvalStore({ directory })` 保存具有版本的 JSON 计划、trial 状态、JSONL
事件和证据文件。每个实验通过 `writer-lock.sqlite` 的 SQLite 独占事务限定
一个写入者，进程终止后由操作系统释放所有权。状态通过原子替换更新，读写
均验证 ID 和 schema。进程使用实验期间，保留所有权数据库文件。

默认事件仅保存允许的计量及 ID 字段。内容保存需要 `retainContent: true`。
宿主 `redact` 在持久化前处理项目敏感内容，也处理输出、错误信息、验收信息
和证据标签。凭据保存在输入、组件 `options` 和配置快照之外，宿主负责明文
记录的访问控制、备份、保留和删除。

存储限制：

| 对象 | 默认或固定上限 |
| --- | --- |
| 计划和状态记录 | 每份 32 MiB |
| 遥测事件 | 每项 64 KiB |
| 单个 trial 的事件文件 | 20,000 项或 16 MiB |
| 内存中的单个指标范围 | 10,000 项独立事件 |
| 单项证据 | 默认 65,536 字节 |
| 单个 trial 的证据 | 默认 1,048,576 字节、64 项 |

达到限制后以明确错误终止工作。完整输出只在 `retainContent: true` 时保存，
受内容处理和证据大小限制。

自定义 `redact` 要求证据规则包含 `redactorId` 和 `redactorVersion`，两项字段
保存并参与版本比较，回调由可信宿主保管，重启后必须提供相同回调。

ID 使用 1–128 个字母、数字、`.`、`_` 或 `-`，以字母或数字开头。JSON 数据
必须能够完整保存，数值有限，嵌套最多 32 层。执行前拒绝名称表明凭据的配置
字段，文本中的项目凭据仍需要宿主清除。

## 报告与比较门槛

成功率分母包含全部计划 trial。成功要求执行正常完成、必需验收通过及基础
设施处理成功。报告保留尚未开始、失败、取消、达到限制、中断、无法判定和
等待审核的记录，人工协助与自动执行的配置分别统计。

比较要求案例、环境和验收版本及指纹匹配，包含全部重复执行、各案例变化、
指标覆盖率、时间和费用分布。时间及费用使用相同案例集合，缺失指标保留
不完整标记。

```powershell
pnpm eval compare --baseline .eval-results/baseline --candidate .eval-results/candidate
pnpm eval compare --baseline .eval-results/baseline --candidate .eval-results/candidate --thresholds ./thresholds.json
```

门槛文件声明最低成功率、允许出现退步的案例和费用限制。未通过时返回非零
状态并保留比较报告。将以下 JSON 保存为 `thresholds.json`：

```json
{
  "minimumSuccessRate": 0.9,
  "allowedRegressedCases": [],
  "maxCostIncreaseRatio": 0.1
}
```

`minimumSuccessRate` 范围为 `[0, 1]`，空的 `allowedRegressedCases` 禁止所有
案例退步，省略时不配置这项门槛。费用比例 `0.1` 允许增加 10%，要求完整计量
和相同币种。没有门槛文件时检查兼容性并报告变化。实验包含多个配置时使用
`--baseline-variant` 和 `--candidate-variant`。未提供计量信息的外部命令将
模型消耗记为未知，无法满足完整费用比较门槛。

## 包范围与验证

公共 package 为 `@may/eval`，`@may/eval-cli` 和可执行案例保持 private。
运行时依赖包含 Core、Application、Coordination、Observability、Permissions，
以及 schema 验证和进程取消使用的第三方库。打包安装检查覆盖仓库之外的使用。

```powershell
pnpm --filter @may/eval test
pnpm --filter @may/eval-cli test
pnpm test:package:eval
pnpm test:integration:eval
pnpm docs:check
```

离线测试使用实际文件、进程、环境准备和命令验收，覆盖生命周期及验收行为。
模型成功率、强制隔离和性能结论需要对应真实环境证据。

`test:integration:eval` 通过 `loadMayConfig()` 读取宿主配置，使用配置的
provider 和模型执行真实单 Agent、任务图、模型评分、权限处理和预算检查。
命令需要 provider 访问，会消耗模型额度，保存模型、用量和验收证据。
记录位于 `eval-verification/live/run-*`，说明本次配置的任务及模型。
