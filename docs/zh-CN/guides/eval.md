# Agent 行为评估

[English](../../en/guides/eval.md) | **简体中文**

`@may/eval` 在独立环境中执行带有版本的任务，并验收实际结果。
它记录通过、失败、超出限制与中断的执行，保存验收证据、人工协助与资源消耗。
runner 可以使用相同案例与验收规则，比较模型、提示词、工具、权限与 Context 配置。

## 案例、配置与 registry

`EvalCase` 包含 `id`、`version`、`description`、`input`、`environment`、
`evaluators` 与 `limits`。组件引用包含 `id`、`version` 与可选的 JSON `options`。
至少一个 evaluator 必须设置 `required`。`requiredCapabilities` 声明需要的环境
能力；`evaluateAfterLimit` 允许执行超过限制后，在终止已经确认时继续验收。

`EvalVariant` 声明执行组件与 JSON `configuration` 快照，可以覆盖 `runBudget`，
并通过 `assisted` 标记人工协助。凭据由宿主配置保存。快照可以保存配置引用、
模型名称、提示词版本与工具版本。

`EvalExperiment` 确定身份、案例、variant、重复次数、并发数量、seed 与证据规则。
`EvalRegistry` 保存显式注册的环境、执行与 evaluator 组件。开始执行前验证准确的
组件版本，以及预算、超时、身份、required evaluator 和环境能力。

使用 `registerEnvironment()`、`registerExecution()` 与 `registerEvaluator()`
注册组件。宿主 callback 及其保存的配置属于可信实现代码。
具有行为影响的设置应当保存在组件 options 或 variant 快照中；行为变化时更新
组件版本。

runner 在执行之前保存完整 trial 计划与配置指纹。每个
`case × variant × repetition` 获得独立 trial 身份。使用 seed 交错安排 variant
执行顺序。这个 seed 控制顺序；provider 的随机行为使用另外的配置。

## 执行可信 suite

private CLI 加载导出 `experiment` 与 `registry` 的 JavaScript module。
导入 suite 会执行代码，并拥有宿主的文件、进程与网络权限。只加载可信 module。

```powershell
pnpm eval validate --suite apps/eval/examples/suite.mjs
pnpm eval run --suite apps/eval/examples/suite.mjs --output .eval-results
pnpm eval report --experiment .eval-results/file-artifact
pnpm eval resume --suite apps/eval/examples/suite.mjs --experiment .eval-results/file-artifact
```

`--output` 指定存储根目录；每个实验使用以实验身份命名的目录。
存储根目录应当位于候选 Agent 工作目录之外。执行或验收失败时仍然保存报告，
CLI 返回非零状态。SIGINT 与 SIGTERM 请求取消，并保存已经开始的 trial 记录。

内置 file-artifact suite 使用真实命令写入文件，再独立检查文件，验证评估生命周期
与 CLI。这个 suite 的数据说明命令执行情况。真实 Agent 评估通过 Application
或 Coordination adapter 使用宿主配置的模型与权限策略，记录模型任务完成能力。

组件使用者可以直接执行相同的 suite：

```ts
import { EvalRunner } from "@may/eval";
import { FileEvalStore } from "@may/eval/file-store";
import { experiment, registry } from "./suite.mjs";

const controller = new AbortController();
const runner = new EvalRunner({
  registry,
  store: new FileEvalStore({ directory: ".eval-results" }),
  signal: controller.signal,
  onTrial: state => console.log(state.trial.id, state.taskVerdict),
});
runner.validate(experiment);
const report = await runner.run(experiment);
```

## 环境生命周期

`EvalEnvironmentAdapter.prepare()` 创建独立资源并返回 `PreparedEnvironment`。
`executionTarget` 提供候选执行需要的资源。全部 Agent 工作终止后，`freeze()`
返回 `EvaluationTarget`。`dispose()` 清理组件拥有的资源，并支持重复调用。
重启恢复可以使用环境提供的 `recover()`。

环境能力字段为 `independentResources`、`filesystemIsolation`、`processIsolation`、
`networkIsolation`、`credentialIsolation` 与可选的 `protectedEvaluationResources`。
本地目录副本创建独立文件，宿主
进程继续拥有宿主权限，因此目录副本无法强制限制对验收代码、答案与凭据的访问。
需要这些限制的案例必须声明相应能力，并使用宿主提供的隔离环境。
能力声明由宿主负责，通过对应环境的安装与隔离测试验证实际行为。

验收程序、预期答案、存储文件与评分凭据保存在候选工作目录之外。
服务需要独立数据库、命名空间或账户。资源无法独立的环境拒绝并发执行。
环境负责管理进程、网络与凭据范围。

`createLocalDirectoryEnvironment({ sourceDirectory, rootDirectory, id?, version?,
maxFiles?, maxBytes?, excludeNames? })` 提供内置目录 adapter。
默认限制每个快照 10,000 个文件与 67,108,864 字节。按照 basename 排除 `.git`、
`node_modules`、`.env`、`.env.*` 与 `.eval-results`；宿主补充项目需要排除的名称。
baseline 与 frozen 快照继续用于后续验收；清理操作删除活动的候选工作目录。
宿主分别管理快照与存储记录的保留时间。

## 执行与取消

trial 按照 `prepare → execute → freeze → evaluate → cleanup` 执行。
每个阶段记录开始、结束、耗时与结果，并在阶段转换前保存记录。
阶段具有独立超时，执行阶段还接收 `RunBudget`。

execution adapter 创建具有 `execute()`、`cancel()` 与 `close()` 的 `EvalExecution`，
并且必须报告 `terminationConfirmed`。超时或取消时，runner 请求终止、等待确认，
并保存证据。无法确认时记录 `termination-unconfirmed`，阻止可能修改仍被 Agent
使用的资源的验收操作。清理错误与原始错误分别保留。
进行中的 freeze 与验收工作必须结束后，才可以清理环境。evaluator 无法确认
终止时，保留环境并停止后续验收。等待超过清理限制时，资源继续供宿主检查。

`createCommandExecutionAdapter({ id, version, command, confirmTermination?,
validate? })` 使用明确的 executable、参数数组与绝对工作目录。
`confirmTermination({ context, command, outcome, signal })` 由宿主检查任务启动的
全部进程是否已经终止。进程结果中的 `processTerminationConfirmed` 表示直接
启动的进程已经终止。父进程正常退出仍然可能存在运行中的后代进程。
没有宿主检查 callback 时，执行报告 `terminationConfirmed: false`，runner
保留活动目录供宿主检查。

`createNodeCommandExecutionAdapter({ id, version, command, validate? })` 支持可信
Node.js 程序。command 返回绝对 `script` 与 `cwd`，以及可选的 `args`、`env`
与 `maxOutputBytes`。组件启用 Node 的 `--permission` 模式，允许读取脚本与
工作目录、写入工作目录，禁止创建子进程、worker、native addon 与 WASI。
组件拒绝覆盖 `NODE_OPTIONS` 与 `NODE_PATH`。受控程序的进程终止后，组件能够
确认执行已经终止。Node permission 模式适用于可信代码；强制进程与凭据隔离
仍然需要宿主环境提供相应能力。

Application adapter 消费 Application events，保存 Session 与 Run 身份。
Coordination adapter 等待任务图，保存 coordination 与节点执行身份。
`yielded`、等待与恢复状态需要明确的宿主处理。权限由宿主提供，固定策略审批
与真实人工审批都会记录。交互入口不可用时，以明确结果终止。
人工审批等待时间单独计量。

`@may/eval/application` 导出
`createApplicationExecutionAdapter({ version, open, input?, approvals?,
continueAfterYield?, maxContinuations? })`。`open({ context, tracer, budget })`
callback 返回全新的 `AgentApplication`。向 Application 提供 `tracer`，并使用
`budget.wrapModel(realModel)`，以及 `budget.wrapTools(realTools)` 或
`budget.wrapToolExecutor(realExecutor)`。预算覆盖全部输入与继续执行。
没有自定义 `input()` mapper 时，案例消息都必须具有 `role: "user"`。
默认允许继续执行 32 次。
输出通过 `text` 保存最终文本，通过 `json` 数组保存 structured values，
没有对应内容时省略字段。

`@may/eval/coordination` 导出
`createCoordinationExecutionAdapter({ version, create, outputTaskId?, approvals? })`。
`create({ context, tracer, budget })` callback 创建全新的 `CoordinationRuntime`，
全部模型与工具使用相同预算 wrapper。限制覆盖整个任务图。
没有绑定预算时拒绝执行。`outputTaskId` 指定需要返回最终文本的任务；
省略时，结果包含全部任务身份、状态与最终文本。

审批处理提供 `decide(request, signal)`。人工决定需要处理器设置 `assisted: true`；
固定宿主策略保持自动执行。variant 可以显式设置 `assisted: true`。
记录到人工介入时，报告也会标记人工协助。adapter 处理审批请求与决定，计量等待时间。
telemetry 证据保存请求与 Session 身份、请求与决定时间、决定及状态，省略工具输入。

## 重启与重新执行

`resume()` 保留已经完成的 trial，仅启动尚未开始的 trial。
已经开始却没有最终状态的 trial 标记为 `interrupted`。执行已经开始时，execution
adapter 的可选 `recover()` 必须确认执行已经终止，随后环境的 `recover()` 才能
清理资源。无法确认时，记录保留 `termination-unconfirmed`，目录继续用于宿主检查。
尚未开始的 trial 使用独立资源。registry 版本与实验指纹必须符合已接受的计划。

实验包含运行时清除凭据的 callback 时，需要向 `resume(experimentId, experiment)`、
`retry(experimentId, trialId, experiment)` 或
`evaluateTrial(experimentId, trialId, evaluatorId, experiment)` 传入原始可信实验。
人工评分通过 `grade(experimentId, trialId, evaluatorId, result, experiment)` 恢复
相同 callback。CLI 通过 `--suite` 恢复这个实验，grade 支持这个可选参数。
callback 身份与版本会保存；必要的 callback
缺失时拒绝继续执行。

API 的显式 `retry()` 创建新的 trial，通过 `retryOf` 关联原始记录，并保存原始
结果。任务不会自动重新执行。provider 按照 variant 的策略重试，请求 attempt
计量包含这些请求。存储损坏与不兼容 schema version 立即抛出错误。

## 验收与评分

`EvalEvaluator` 接收固定的目标、执行结果、案例、variant、options、evidence sink
与 event emitter，返回 verdict、checks、可选 scores 与证据引用。
内置 evaluator 支持命令、JSON Schema、文件变化与组合检查。
命令检查明确 executable、args、工作目录与超时。文件检查验证允许修改的范围
及声明的内容要求。成熟文件格式使用对应第三方库读取。

内置 factory 为 `createCommandEvaluator({ id, version, command, confirmTermination?,
expectedExitCode?, validate? })`、
`createNodeCommandEvaluator({ id, version, command, expectedExitCode?, validate? })`、
`createJsonSchemaEvaluator({ schema, read?, id?, version? })`、
`createFileChangesEvaluator({ allowedPaths, requirements?, id?, version? })`、
`createCompositeEvaluator({ id, version, evaluators })` 与
`createHumanEvaluator(id?, version?)`。命令明确 executable 与参数数组。
schema evaluator 默认读取 `execution.output`，`read()` 可以提供需要检查的数据。
文件要求支持存在状态、完整文本、包含文本与 SHA-256，并检查 frozen 快照。
允许修改的路径使用完整、规范的相对路径。组合 evaluator 按照顺序执行检查。

通用命令 evaluator 需要宿主提供全部进程的终止检查，与通用 execution adapter
相同。缺少确认时记录 `termination-unconfirmed`，验收结果为 `inconclusive`。
Node evaluator 使用相同的受控 Node permission 模式，以及绝对脚本与工作目录
配置。

文件验收会重新计算 frozen 目录的完整 manifest，将路径、字节数量与 SHA-256
同保存的快照比较，随后检查文件要求。快照内容改变时拒绝验收。
`readEvaluationFile()` 要求规范的相对路径与 frozen 目录内的普通文件，拒绝
symbolic links，并在读取之前及读取之后检查字节限制。
默认限制为 1,048,576 字节；宿主可以提供明确的正数限制。

required 结果决定 `taskVerdict`：任何 required 检查失败时为 `failed`；
全部 required 检查通过时为 `passed`；其他情况为 `inconclusive`。
optional 检查保存证据与分数。案例可以通过 evaluator 显式设置分数阈值。

人工审核返回 `awaiting-review`。后续评分追加 evaluator revision，并保留此前
revision。使用 JSON `EvaluationResult` 提交评分：

```powershell
pnpm eval grade --experiment .eval-results/file-artifact --trial <trialId> --evaluator <evaluatorId> --result ./review-result.json
```

实验声明自定义 redactor 时，添加 `--suite ./suite.mjs`。

`createModelEvaluator({ version, modelId, promptVersion, rules, model, runBudget,
input?, responseFormat?, scoreThresholds?, id? })` 使用真实 May 模型调用执行可选模型评分。
宿主提供模型与规则。evaluator 保存模型身份、提示词版本、规则、schema、
原始结果与证据，并将候选内容作为待评分数据。分数范围为零至一。
无效输出、检查结果不一致或评分请求失败产生 `inconclusive`。
候选 Agent 与评分模型的消耗分别记录。
`scoreThresholds` 可以在注册的 evaluator 或案例引用 options 中声明。
每项门槛处于 `[0, 1]` 范围；需要的分数缺失时为 `inconclusive`，低于门槛时
对应检查为 `failed`。没有声明的分数门槛不会自动参与判定。

## 结果与指标

每个 trial 分别保存 `executionStatus`、`taskVerdict` 与 `infrastructureStatus`。
达到限制后的任务仍然可以满足验收条件；执行记录继续保存 `limited`。
基础设施错误保留失败阶段与错误代码。原因未知时保存 `unknown`。

runner 记录耗时、审批等待、模型调用、provider attempts、重试等待、工具调用与
错误、Context 压缩、人工介入、token 与费用。稳定的 event 身份防止重复计量。
usage 或价格缺失时保存缺失原因。`UsageCost` 保存完整性与宿主提供的价格版本。
grader 指标具有独立合计。

Application 与 Coordination adapter 传递 Core telemetry correlation，关联 trial
证据与 Session、Run、coordination、trace 身份。评分 revision 可以转换成
Observability `TaskAssessment`；EvalStore 是实验持久记录的来源。
DiagnosticsStore 用于关联查询，并具有独立保留限制。

## 证据与存储

`FileEvalStore({ directory })` 保存带有版本的 JSON 计划、trial 状态、JSONL events
与证据文件。每个实验通过 `writer-lock.sqlite` 中的 SQLite exclusive transaction
限定一个 writer；进程终止后由操作系统释放所有权。状态文件通过原子替换
更新，读取和写入时验证身份与 schema。存在进程使用实验期间，保留所有权
数据库文件。

默认 events 只保存允许的计量与身份字段。证据规则限制单项字节、trial 总字节
与项目数量。保存内容需要 `retainContent: true`。宿主 `redact` 函数在保存前
清除项目凭据。输入、组件 options 与配置快照不得包含凭据。
宿主负责明文记录的文件访问、备份、保留与删除。
相同的凭据清除也会处理保存的输出、错误信息、验收检查信息与证据 label。

计划与状态记录限制为 32 MiB。每项 telemetry event 限制为 64 KiB。
一个 trial 的 event 文件可以追加 20,000 项记录或 16 MiB；内存中的每个指标范围
最多接受 10,000 项独立 event。超出限制时以明确错误终止工作。
完整执行输出仅在 `retainContent: true` 时保存，并受凭据清除与证据大小限制。

自定义 `redact` callback 要求证据规则包含 `redactorId` 与 `redactorVersion`。
这些字段用于保存与比较，callback 由可信宿主保管。重启后需要恢复相同 callback。

默认限制为每项证据 65,536 字节、每个 trial 1,048,576 字节与 64 项证据。
identifier 使用 1–128 个字符，包含字母、数字、`.`、`_` 与 `-`，以字母或数字开头。
JSON 数据必须能够完整保存，数值有限，嵌套深度不超过 32。
执行前拒绝名称表明凭据的配置字段。文本中的项目凭据仍然需要宿主清除。

## 报告与比较门槛

成功率分母包含全部计划 trial。成功需要执行正常完成、required 验收通过，以及
基础设施处理成功。报告同时显示尚未开始、失败、取消、超出限制、中断、无法
判定与等待审核的记录。人工协助与自动执行的 variant 保存独立统计。

比较要求案例、环境、evaluator 的版本与指纹相同。报告包含全部重复执行、
每个案例的变化、指标覆盖率、时间与费用分布。指标缺失时显示完整性。
时间与费用比较使用相同案例集合。

```powershell
pnpm eval compare --baseline .eval-results/baseline --candidate .eval-results/candidate
pnpm eval compare --baseline .eval-results/baseline --candidate .eval-results/candidate --thresholds ./thresholds.json
```

门槛显式声明最低成功率、允许的退步与费用限制。比较未通过门槛时返回非零
状态，并保留比较报告。

```json
{
  "minimumSuccessRate": 0.9,
  "allowedRegressedCases": [],
  "maxCostIncreaseRatio": 0.1
}
```

`minimumSuccessRate` 使用 `[0, 1]` 范围。`allowedRegressedCases` 为空数组时
不允许任何案例退步；省略这个字段时不配置这项门槛。费用比例 `0.1` 允许增加
10%，并要求计量完整且币种相同。没有门槛文件时，比较检查兼容性并报告变化。
实验包含多个 variant 时使用 `--baseline-variant` 与 `--candidate-variant`。
没有计量信息的外部命令将模型消耗记录为未知，因此无法满足完整费用比较门槛。

## 包范围与验证

这个功能的发布范围为 `@may/eval`。`@may/eval-cli` 与可执行 suite 保持 private。
公共运行依赖包含 Core、Application、Coordination、Observability、Permissions，
以及 schema validation 和进程取消使用的库。打包后的独立 consumer 验证仓库
之外的安装与运行。

```powershell
pnpm --filter @may/eval test
pnpm --filter @may/eval-cli test
pnpm test:package:eval
pnpm test:integration:eval
pnpm docs:check
```

离线测试使用实际文件、进程、环境准备与命令验收。真实模型集成需要配置
provider 访问，记录模型、usage 与验收证据。离线测试通过能够验证生命周期
与验收行为。模型成功率、强制隔离与性能结论需要对应的真实环境证据。

`test:integration:eval` 通过 `loadMayConfig()` 读取宿主 May 配置，选择已经配置的
provider 与模型。它执行真实单个 Agent 与任务图 trial、模型评分、权限处理与
预算检查。记录保存在 `eval-verification/live/run-*`，供后续检查；这些记录说明
本次执行中配置的任务与使用的模型。
