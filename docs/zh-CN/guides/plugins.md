# 插件、服务与生命周期 Hooks

[English](../../en/guides/plugins.md) | **简体中文**

`@may/plugin` 管理插件配置和资源。`@may/core` 声明带类型的 Hook 接口及
`AgentRuntime`；`@may/application` 将它们与权限、Context 和持久 Session
存储组合。参阅[规格](../architecture/plugin-spec.md)。

## 插件的定义与组成

插件是由宿主管理的功能单元。它声明自己的身份、提供的能力、需要的依赖及初始化
方法。宿主根据这些声明检查组合，按照依赖顺序初始化，并在关闭时释放资源。

现有部件可以通过这些声明直接作为插件使用。插件内部可以包含类、函数和其他部件，
例如由同一个 runtime 插件共同管理 Agent loop 和配套 Context。组件可以作为普通
描述使用，应用通过插件声明选择和组合功能。

`PluginDefinition` 包含以下字段：

| 部分 | 字段 | 要求及作用 |
| --- | --- | --- |
| 身份 | `id`、`version` | 必需；标识插件及 Semantic Version |
| 初始化 | `setup(ctx)` | 必需；创建实例、提供服务、注册 Hooks 和清理方法 |
| 生命周期范围 | `scope` | 可选；`host`、`application`、`session` 或 `run`，默认 `application` |
| 配置 | `config`、`configSchema` | 可选；提供配置及 JSON Schema 验证规则 |
| 提供的能力 | `provides` | 可选；声明提供的 ServiceToken，通过 `ctx.provide()` 注册实例 |
| 服务依赖 | `requires`、`optional` | 可选；声明必需及可选服务，可以要求版本范围和能力 |
| Hook 要求 | `requiresHooks` | 可选；声明宿主需要支持的 Hook 入口 |
| 状态 | `state` | 可选；声明必需的 `version`、`initial`，以及可选 `schema`、`compatibleVersions`、`migrate` |

插件根据自身功能选择可选字段。资源可以通过 `ctx.defer()` 登记清理方法，
`setup()` 也可以返回一个同步或异步清理方法。

### PluginContext 与 ctx

`PluginContext` 是 May 已实现的插件管理接口。PluginHost 初始化每个插件实例时
创建对应的对象，并传给 `setup(ctx)`。`ctx` 是示例中的参数名称，可以自行命名。

| 接口 | 作用 |
| --- | --- |
| `pluginId`、`pluginOrder`、`scope`、`scopeId` | 标识当前插件、声明顺序及其所属范围实例 |
| `config` | 取得经过配置验证的只读配置副本 |
| `get()`、`optional()` | 取得已声明的必需或可选依赖服务 |
| `provide()` | 注册已声明的服务实例 |
| `on()` | 注册 Hook handler，宿主管理顺序、超时、取消和清理 |
| `state.get()`、`state.set()`、`state.update()` | 读取状态副本，验证更新并等待保存方法完成 |
| `defer()` | 登记资源清理方法 |
| `signal` | 接收初始化取消、范围关闭及插件卸载通知 |

PluginContext 用于插件配置和生命周期管理。Agent 的 `Context` 接口负责保存和
提供模型可见的消息，两者分别承担这些职责。

## 声明插件

```ts
import { definePlugin, defineService } from "@may/plugin";
import { applicationHooks } from "@may/application";

const labels = defineService<{ prefix: string }>({
  id: "example.labels", version: "1.0.0", scope: "application",
});

const labelsPlugin = definePlugin({
  id: "example.labels", version: "1.0.0", provides: [labels],
  config: { prefix: "Project: " },
  configSchema: {
    type: "object", required: ["prefix"], additionalProperties: false,
    properties: { prefix: { type: "string" } },
  },
  setup(ctx) { ctx.provide(labels, ctx.config); },
});

const inputPlugin = definePlugin({
  id: "example.input", version: "1.0.0",
  requires: [{ service: labels, version: "^1.0.0" }],
  requiresHooks: [applicationHooks.inputBeforeSubmit],
  setup(ctx) {
    const label = ctx.get(labels);
    ctx.on(applicationHooks.inputBeforeSubmit, (value) => ({
      ...value,
      input: typeof value.input === "string"
        ? label.prefix + value.input : value.input,
    }));
  },
});
```

将 `[inputPlugin, labelsPlugin]` 作为 `plugins` 传入 `defineAgent()` 或
`AgentApplication.open()`。初始化按照依赖顺序执行，相同优先级的 Hook 按照插件
配置顺序执行。一个插件可以提供多个服务并注册多个 Hooks。

配置 schema 通过 Ajv 验证。ServiceToken
包含 `id`、明确 Semantic Version、范围及能力。依赖可以声明版本范围及需要的能力。
缺失的可选服务通过 `ctx.optional()` 返回 `undefined`；已经存在的可选服务也需要
符合版本和能力要求。`ctx.get()` 和 `ctx.optional()` 需要声明对应依赖。

重复插件 id、重复服务提供方、依赖缺失、版本不兼容、能力不足、循环依赖、未知必需
Hook 以及更短生命周期服务依赖，都在插件初始化前导致验证失败。

## 管理范围内的资源

范围按照 `host` → `application` → `session` → `run` 嵌套。子范围可以使用自身
和上级范围的服务。每个子范围独立创建自己的插件实例。初始化遵循依赖顺序，清理
遵循依赖逆序。

`ctx.defer()` 注册同步或异步清理方法。`setup` 也可以返回一个清理方法。
`ctx.on()` 自动注册取消监听操作。获取资源时立即注册清理方法，初始化失败时可以
释放已经获取的资源。关闭操作等待活动操作，按照子范围到上级范围的顺序释放资源，
继续处理单个清理失败，使用 `AggregateError` 报告全部错误。重复调用 `close()`
使用相同完成结果。

直接使用宿主：

```ts
const host = await PluginHost.create({ plugins, hooks: [myHook], services });
const application = await host.createScope("application", { id: "app" });
const session = await application.createScope("session", { id: "conversation" });
await session.use(() => operation(), { cancel: () => cancelOperation() });
await host.close();
```

`use()` 将操作登记到全部上级范围。通过 `services` 传入的资源继续由调用方管理；
插件获取的资源使用插件清理方法。取消信号通知操作终止，handler 和清理方法需要
响应取消，以便宿主完成等待。

## 转换和观察生命周期数据

`defineHook()` 创建具名 Hook，声明 `kind: "transform"` 或 `"observe"`
及验证方法。`runtimeHooks` 和 `applicationHooks` 提供以下入口：

| 范围 | Hook 导出 |
| --- | --- |
| Application | `beforeCreate`、`created`、`beforeClose`、`closed` |
| 输入 | `inputReceived`、`inputBeforeSubmit`、`inputSubmitted` |
| Run | `runBefore`、`runStarted`、`runBeforeEnd`、`runEnded`、`runFailed` |
| Step | `stepBefore`、`stepCompleted` |
| Context | `contextBefore`、`contextAfter`、`compactionBefore`、`compactionCompleted`、`compactionFailed` |
| 模型 | `modelBefore`、`modelEvent`、`modelAfter`、`modelFailed` |
| 工具 | `toolBefore`、`toolProgress`、`toolResult`、`toolAfter`、`toolFailed` |
| 审批和恢复 | `approvalRequested`、`approvalResolved`、`recoveryBefore`、`recoveryResolved` |

`ctx.on(hook, handler, { order, timeoutMs, failure })` 注册 handler。
执行顺序依次由升序 `order`、插件配置顺序、注册顺序决定。每个 handler 获得复制后
不可修改的数据，以及包含 `AbortSignal` 和当前 Session、Run、Step 标识的上下文。
转换 handler 返回经过验证的替换数据，返回 `undefined` 时保留当前值。观察 handler
不返回替换值。默认超时为 30000 毫秒，通过 `PluginHostOptions.timeoutMs` 或
`AgentApplicationOptions.pluginHookTimeoutMs` 配置。

错误默认传播。明确启用观察错误隔离时，需要提供 `PluginHostOptions.onHookError`，
宿主等待错误报告完成。转换错误始终传播。终止观察 Hooks 声明 `allowAborted`，
使取消结果仍然能够被观察。直接使用 `May` 的应用可以注入 `HookDispatcher`。
应用通过 `onPluginHookError` 提供错误报告方法。

`toolBefore` 在 JSON 解析后、工具验证和权限判定前转换输入。工具名称和调用标识
保持固定，最终验证后的参数在权限判定和执行期间保持不可修改。`toolResult` 转换
模型可见内容，持久工具记录保留原始输出。`runBeforeEnd` 可以通过
`continueMessages` 请求继续，Session 确认保存生成输入后开始下一个 Step。
取消、Run 预算和宿主 yield 继续控制是否允许继续。

可选 `Tool.parse()` 验证或转换经过 Hook 处理的参数。`inputSchema` 向模型声明
工具输入。需要执行验证的工具提供 `parse()`。

`freezeToolInput()` 递归保护解析后的对象和数组，保留自定义实例的 prototype 和
方法。工具和权限策略需要将输入视为只读数据。Date、Map、Set 等具有可变内部状态
的内建容器，需要使用普通数据对象或数组表示。自定义 class 需要自行保护没有公开
为自身字段的内部状态。

## Runtime 和应用服务

`@may/plugin-services` 定义共享的带类型服务标识。`applicationServices` 导出相同
标识，并增加 `application`；其 `get()` 在创建阶段完成后返回活动 AgentApplication。
服务包括 `model`、`modelInfo`、`contextFactory`、`contextOptions`、`sessionStore`、
`permissionPolicy`、`toolExecutor`、`toolScheduler`、`tracer`、`tools`、`skills`、
`runtimeFactory`、`toolSources`、`instructionSources`、`modelWrappers` 和
`contextWrappers`。直接 options 通过对应的插件工厂参与组合。通过插件提供服务时，
需要保证提供方唯一。一个插件可以共同提供 runtime factory 和相应 Context factory。
通过 `open({ store })` 传入的 Session 存储是由调用方管理的入口服务，恢复过程也
使用该实例；同一个 Session 保持相同存储实例。

`createModelPlugin({ create, info })` 可以同时提供 `modelInfo`，描述实际实例的
provider、model、adapter 和 profile。仅提供 `model` 的插件将未知名称保持为
`undefined`。Application 插件提供 Model 时，MaybeCode 可以使用空的 `providers`
和 `models` 配置。Context 预算采用有效 Model 的 `limits`，明确提供的
`contextBudget` 优先。profile 选择、reasoning effort 修改及配置层的 MCP sampling
工厂使用配置提供的模型工厂。自定义 Model 插件可以按需求提供相关能力。

保留的 trace 字段 `may.model.provider`、`may.model.name`、`may.model.adapter`
和 `may.model.profile` 来自活动的 `modelInfo` 服务。通过
`createModelPlugin({ create, info })` 提供这些字段；仅提供 Model 的插件将这些
字段保持为 `undefined`。其他调用方定义的 trace 属性继续保留。

工具和指令通过 `add(value, { id, order, pluginOrder })` 登记，返回清理方法。
执行顺序依次取决于 `order`、插件声明顺序和登记顺序。每个 Run 创建工具快照，
重复名称立即导致错误。创建每个 runtime 时分别应用 Model 和 Context 包装。
`contextOptions` 可以根据完整包装后的 Model 生成配置。插件通过
`applicationHooks.created` 取得已创建的 Application；替换时再次通知创建处理方法，
让新服务绑定到已有 Application。

## 可复用插件 package

公开的可复用插件 package 列表如下：

| Package | 工厂及职责 |
| --- | --- |
| `@may/plugin-runtime` | `createRuntimePlugin`、`createContextPlugin`、`createToolsPlugin`、`createContextWrapperPlugin`；组合 runtime、Context 和工具 |
| `@may/plugin-models` | `createModelPlugin`、`createModelWrapperPlugin`；Model 实例及包装 |
| `@may/plugin-permissions` | `createPermissionPlugin`；PermissionPolicy |
| `@may/plugin-skills` | `createSkillsPlugin`；发现、激活、指令、工具及状态保存 |
| `@may/plugin-goals` | `createGoalsPlugin`；持久目标、预算及继续执行 |
| `@may/plugin-history-memory` | `createHistoryMemoryPlugin`；历史 Context 笔记、查询和压缩 |
| `@may/plugin-delegation` | `createDelegationPlugin`、`createWorkspaceFilesPlugin`；子 Agent、共享预算及工作区文件访问 |
| `@may/plugin-mcp` | `createMcpPlugin`、`createMcpHostPlugin`、`createSharedMcpPlugin`；连接、工具目录、认证、交互及任务日志 |
| `@may/plugin-observability` | application、host 和共享资源工厂；tracing 及 exporter 关闭 |
| `@may/plugin-delivery` | `createDeliveryPlugin`；持久渠道记录、接收方登记及单次投递结果 |
| `@may/plugin-channel-telegram` | `createTelegramChannelPlugin`；Telegram 接收、路由及附件 |
| `@may/plugin-channel-feishu` | `createFeishuChannelPlugin`；Feishu 接收、路由及附件 |
| `@may/plugin-agent-adapters` | `createAgentAdaptersPlugin`、`createMayAgentAdapter`、`loadAgentAdapter` 和 RPC adapters；对话及 adapter 资源管理 |
| `@may/plugin-coordination` | `createCoordinationPlugin`；任务图创建、恢复和释放 |
| `@may/plugin-web-api` | `createWebApiPlugin`；HTTP 监听、活动请求及连接 |

可复用实现位于 `packages/plugins/<name>/`。共享服务标识和有序贡献登记位于
`packages/plugin-services/`，插件宿主位于 `packages/plugin/`。产品组合位于
`apps/maybecode/src/plugins/` 和 `apps/maybeclaw/src/plugins/`。
现有 package 的类和接口继续支持直接调用，应用保留已提取功能的兼容导出。

`@may/plugin-agent-adapters` 通过 `AgentAdapterContext.telemetry` 接收经过验证的
version 1 `TelemetryCorrelation`。Gateway RPC 在 `gateway/initialize` 中声明
`telemetryVersion: 1`，远端确认该版本后，`conversation/execute` 包含独立的
`telemetry` envelope。省略该响应字段的远端继续接收原执行字段。发送方与接收方在
执行前验证关联身份，业务请求的重复判断不包含遥测身份。随 package 提供的
`rpc-file-agent` 示例支持该协商，在输入 hash 之外单独保存遥测，并在返回已完成输入
结果时保留原执行身份。

MaybeCode 通过插件组合 Model、PermissionPolicy、Context、Skills、goals、
history-memory 和 delegation。MCP 命令、目录和事件使用活动 Application 的
`mcpService`。Application 管理的连接池随每个 Session 启动和关闭；配置提供的
共享连接池和 observability 资源由工作区宿主管理。选中的 MCP 提供方会阻止初始化
未使用的配置 MCP 资源。delegation 插件通过可选依赖，为子 Agent 提供活动
`mcpService` 的工具目录。MaybeClaw 宿主组合渠道输入、投递和协议插件；AgentGateway
管理 adapter 和 coordination 插件。空闲释放会从 registry 移除 adapter，下次访问
根据当前配置创建实例。Web 宿主在清理产品路由和认证之前，关闭监听及活动连接。
关闭过程开始取消 Gateway 工作，随后等待 HTTP 请求和资源清理完成。
`GatewayHost.start({ startPaused: true })` 完成服务初始化，`startLoops()` 启动渠道接收、
后台处理和自动投递。暂停期间，`tick()` 处理已保存的输入并创建回复记录；
`deliver()` 明确发送待投递消息。

`pnpm test:package:plugin` 打包宿主、共享服务、全部 15 个可复用插件 package
及其完整 May 运行时依赖，在仓库外的 consumer 目录安装 tarball 并执行导出 API。
应用继续保持 private。新增公开 package 需要通过相同检查。

## Runtime factory

没有插件提供 `runtimeFactory` 时，`defaultRuntimePlugin` 提供默认 May runtime。
`RuntimeFactory` 接收 `MayOptions`，返回 `AgentRuntime`。runtime 提供 `run`、
`continue` 及 `appendMessages`，还可以声明 descriptor、支持的 Hooks 及状态保存和
恢复方法。构造 runtime 后，执行前检查 `supportedHooks` 是否包含插件需要的入口。

`Session` 保存 runtime 标识和版本，恢复时验证兼容性。runtime 状态通过
`stateVersion` 声明版本；版本变化需要 runtime 提供
`migrateState(savedDescriptor, state)`。runtime 自己获取的资源通过可选 `close()`
释放。`Session.getRuntimeInfo()`、`saveRuntimeState()`、`replaceRuntime()`
以及 `suspendRuntime()` 和 `closeRuntime()` 提供对应宿主操作。暂停运行时会保存
状态，并在插件服务释放前关闭旧实例。替换运行时恢复已经保存的状态并重新允许执行。
`AgentApplication.getService(token)`
解析活动范围内的服务。只调用模型的应用可以省略 `permissionPolicy`；执行工具时
需要明确权限策略。

`compactionBefore` 在每个已配置的自动压缩策略执行前触发，可以选择其他已配置
策略。控制 Hook 失败时，自动压缩立即终止。

## 持久状态和组合变更

插件 `state` 声明 `version`、`initial`，以及可选 JSON Schema、
`compatibleVersions` 和 `migrate`。`ctx.state.get()` 返回状态副本。
`set()` 和 `update()` 验证状态并等待范围的 `onStateChange` 保存方法完成。
`snapshotState()` 返回具有版本的记录。恢复不兼容的插件或状态版本需要明确迁移。
历史继续保留未知插件的状态记录。

`AgentApplication` 使用 `may.plugins` 保存 application 和 session 范围状态。
run 范围状态为临时状态。`updatePlugins(plugins, { cancelActive })` 顺序执行组合
变更，等待当前操作完成，验证新依赖图，释放受影响实例，并使用持久消息及状态
创建替换 runtime。`cancelActive: true` 在等待前请求取消。替换初始化失败后，
历史查询仍然可用。

组合变更允许活动操作完成状态写入，随后暂停接受新的状态调用，并等待已经接受的
`set()` 和 `update()` 完成，再清理资源和恢复状态。暂停期间提交的调用会报错。
替换插件的 setup 可以更新恢复后的状态。

直接宿主提供 `replacePlugins()`、`replace()`、`remove()` 和 `updateConfig()`。
`validatePlugins()` 验证准备使用的组合，同时保留当前资源。
移除提供方时，同时移除必需使用方；可选使用方重新初始化并获得缺失结果。子范围
只能修改自身和下级范围。

## 产品加载插件

MaybeCode 读取 `apps.maybecode.plugins`。MaybeClaw 的 May adapter 读取
`apps.maybeclaw.agents[].plugins`：

```json
{
  "plugins": [
    { "module": "./plugins/project.mjs", "export": "default", "config": {} }
  ]
}
```

模块导出 `PluginDefinition` 对象。相对文件路径和已安装 package 名称按照配置文件
位置解析。`export` 默认为 `default`；`enabled: false` 跳过解析及导入。
模块必须解析为本地文件。自定义应用可以使用 `loadPluginModules()` 和
`parsePluginSelections()`。模块具有宿主进程权限；在 `setup` 中获取资源，并通过
`ctx.defer()` 注册清理方法。

运行 `pnpm --filter @may/plugin test`、`pnpm docs:check` 和
`pnpm test:package:plugin`，分别验证宿主、文档及独立安装的 package。
真实 provider 测试独立于离线测试。
