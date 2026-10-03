# @may/plugin

为 May 插件提供带类型的服务、依赖管理、生命周期清理和 Hooks。这个 package 可以独立使用；`@may/application` 将其连接到 Agent 执行过程和 Session 历史。

## 服务与插件

```ts
import { definePlugin, defineService, PluginHost } from "@may/plugin";

interface Counter {
  read(): number;
  increment(): Promise<void>;
}

const counter = defineService<Counter>({
  id: "example.counter",
  version: "1.0.0",
  scope: "session",
  capabilities: ["increment"],
});

const counterPlugin = definePlugin({
  id: "example.counter",
  version: "1.0.0",
  scope: "session",
  provides: [counter],
  state: {
    version: 1,
    initial: { count: 0 },
    schema: {
      type: "object",
      properties: { count: { type: "integer", minimum: 0 } },
      required: ["count"],
      additionalProperties: false,
    },
  },
  setup(ctx) {
    ctx.provide(counter, {
      read: () => ctx.state.get<{ count: number }>().count,
      increment: () => ctx.state.update((value) => {
        const state = value as { count: number };
        return { count: state.count + 1 };
      }),
    });
  },
});

const host = await PluginHost.create({ plugins: [counterPlugin] });
const application = await host.createScope("application", { id: "application" });
const session = await application.createScope("session", { id: "session" });
await session.get(counter).increment();
console.log(session.get(counter).read());
await host.close();
```

`PluginDefinition` 声明 `id`、符合 SemVer 的 `version`、可选的 `config` 与 `configSchema`、`provides`、`requires`、`optional`、`requiresHooks`、持久状态 `state` 和 `setup`。`definePlugin()` 保留配置类型，使 `ctx.config` 具有对应类型。配置通过 Ajv 的 strict 模式校验，使用同步 JSON Schema。创建宿主时保存配置和声明数组的副本，后续变更通过组合管理接口进行。

Service token 包含稳定的 `id`、接口 `version`、`scope` 和能力名称。默认要求接口版本完全匹配；依赖可以明确选择兼容版本范围：

```ts
requires: [{ service: counter, version: "^1.0.0", capabilities: ["increment"] }]
```

`ctx.get(counter)` 获取已声明的必需或可选依赖。`ctx.optional(counter)` 获取已声明的可选依赖，服务缺失时返回 `undefined`。存在的可选服务也要通过版本、能力和范围检查。`ctx.provide()` 只能注册 `provides` 中声明的服务。
依赖解析使用声明的 `version` 范围或依赖自身 Service token 的版本，
即使访问时传入相同 id、相同作用域的另外一个 token，也按照声明的版本取得服务。

宿主在执行任何 `setup` 前验证完整依赖图，包括以后创建的范围。配置错误、缺少依赖、循环依赖、重复插件 ID、重复提供方、版本不兼容、缺少能力和不可用的必需 Hook 都会终止创建。配置中的插件列表为每个范围内的服务选择一个提供方。插件在 `setup` 期间必须注册全部已声明服务。

## 范围与资源归属

范围依次为 `host` → `application` → `session` → `run`，`createScope()` 创建直接下一级，可选的 `signal` 用于取消范围初始化。插件默认使用 `application` 范围；服务明确声明范围。每个插件在对应范围的每个实例中初始化一次。服务可以依赖同级或上级服务。长期存在的插件不能依赖生命周期更短的服务实例；操作资源可以通过明确的 factory 创建。

`PluginHost.create({ services })` 接受由调用方管理的实例，也可以为以后创建的范围提供模板。`createScope({ services })` 可以补充当前范围及后续范围的实例，创建之前同样验证完整依赖图。调用方提供的对象继续由调用方管理；在多个范围提供同一个对象会共享该对象。

获取资源时，通过 `ctx.defer(cleanup)` 登记清理操作；`setup` 也可以返回清理函数。Hooks、服务、连接和监听器归注册它们的插件管理。插件按照依赖的逆序清理，每个插件内部按照资源获取的逆序清理。关闭下级范围保留上级资源。关闭宿主时停止接收新操作、取消活动操作、关闭下级范围、等待 handler 与状态写入完成，并执行全部清理操作；多个清理错误通过 `AggregateError` 报告。重复关闭返回相同的完成 Promise。

初始化和 handler 的超时管理提供 `AbortSignal`。插件必须响应取消信号，并在继续等待前登记已获取资源。宿主等待活动 JavaScript 操作结束后释放资源；及时取消需要插件代码配合。

## Hooks

`@may/core` 导出 `defineHook`、`HookDefinition`、`HookContext`、`HookDispatcher`、`runtimeHooks` 和 `RUNTIME_HOOKS`。Application 接入提供支持的 Hooks；独立宿主明确传入 Hook 列表。

```ts
import { runtimeHooks, RUNTIME_HOOKS } from "@may/core";
import { definePlugin, PluginHost } from "@may/plugin";

const instructions = definePlugin({
  id: "example.instructions",
  version: "1.0.0",
  requiresHooks: [runtimeHooks.contextAfter],
  setup(ctx) {
    ctx.on(runtimeHooks.contextAfter, (snapshot) => ({
      ...snapshot,
      instructions: `${snapshot.instructions ?? ""}\nUse the project formatter.`,
    }), { order: 10, timeoutMs: 5_000 });
  },
});

const host = await PluginHost.create({
  plugins: [instructions],
  hooks: RUNTIME_HOOKS,
});
```

handler 按照 `order` 从小到大执行，随后使用配置中的插件顺序和注册顺序。转换 handler 接收经过完整冻结的副本，返回新值；返回 `undefined` 保留当前值。输入和每个转换结果都经过宿主登记的 Hook validator 验证。数据必须支持 `structuredClone`；服务实例通过 Service 提供，取消信号通过 `HookContext` 提供。

观察 handler 不返回替换值。错误默认传递给当前操作。宿主提供 `onHookError` 时，观察 handler 可以声明 `failure: "isolate"`，相关错误全部通过该接口报告。报告接口接收错误、Hook、插件 ID 和支持取消的 `HookContext`，使用 handler 的超时设置，报告失败会传递给当前操作。转换错误始终传递。声明 `allowAborted` 的 Hook 在操作信号取消后仍然通知失败和取消结果；handler 自身的取消、超时和卸载规则继续生效。

## 持久状态

状态值使用 JSON 数据。`ctx.state.get()` 返回副本。`set()` 和 `update()` 按顺序执行写入，验证 schema，等待 `onStateChange` 保存后公开新值。保存失败时保留原状态，并拒绝当前操作。`snapshotState()` 返回每个插件的 `pluginVersion`、`stateVersion` 和 `value`。

通过 `createScope({ state, onStateChange })` 传入历史状态。恢复和迁移在 `setup` 前完成。状态格式版本保持相同时，历史插件版本还必须满足 `state.compatibleVersions`，默认要求当前插件版本完全匹配。不兼容状态需要明确的 `state.migrate(previous)`。迁移结果通过验证并保存后才能使用。已移除插件的记录继续保存在 snapshot 中，支持检查历史状态和后续迁移。

`@may/application` 将 Session 范围的 snapshot 保存在 Session 历史中。独立宿主通过 `onStateChange` 连接持久存储。Host、Application 和 Run 状态也可以连接调用方提供的存储接口。

## 配置与组合变更

`replacePlugins`、`replace`、`remove` 和 `updateConfig` 按顺序执行组合变更。`validatePlugins()` 验证预期的完整组合，保持资源和初始化状态不变。每次变更同样在释放资源之前验证完整的新组合。变更影响所选范围及全部下级范围，保留上级插件，并按依赖顺序重新初始化组合。移除提供方时，同时移除具有相关必需依赖的插件。初始化失败时，相关组合保持不可执行；`isReady` 表示当前状态，调用方可以明确提供有效组合恢复运行。

`scope.use(operation, { cancel })` 登记活动操作，在完成前同时占用全部上级范围的执行边界。变更等待期间拒绝新操作；默认等待已有操作完成。`{ cancelActive: true }` 调用已登记的取消方法，等待完成后释放资源。Application 自动登记每次 Run，包括历史保存，并在变更后重新建立 runtime。

## 模块配置

`loadPluginModules(selections, configFile)` 按配置文件位置解析已安装的 ESM package 和本地模块。配置包含 `module`，以及可选的命名 `export`、`config` 和 `enabled`。模块默认导出 `PluginDefinition` 对象。创建宿主时验证配置，`setup` 负责创建资源。

## 验证

`pnpm --filter @may/plugin test` 构建 package，并通过真实宿主、文件句柄、Session snapshot、事件监听器和可取消计时器运行 Node 测试。验证覆盖完整依赖图、兼容服务版本、资源归属、范围状态、迁移、不可修改的 Hook 输入、超时、错误报告、组合变更和 ESM 模块加载。这些测试验证宿主行为；真实模型 provider 的运行表现需要相应的集成验证。
