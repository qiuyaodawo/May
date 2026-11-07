# API 稳定性

[English](../../en/reference/stability.md) | **简体中文**

选择公共 API 和审阅升级内容时使用本参考文档。
[兼容性](compatibility.md)说明运行环境和存储限制。

## 稳定性等级

`stable` API 的源码声明使用 `@public`。在 `0.x` 期间，破坏性变更需要 minor 发布
并提供迁移说明。从 `1.0` 开始，破坏性变更需要 major 发布。兼容性修复使用 patch 发布。

`experimental` API 的源码声明使用 `@experimental`。这些 API 可以在 minor 发布中
变化；changeset 说明变更内容及其对使用者的影响。

稳定核心包括 `Model`、`Tool`、`defineTool`、消息和工具结果类型、`defineAgent`、
`AgentDefinition`、`AgentApplication` 基础生命周期（`open`、`submit`、`history`、
`close`）、Session 创建、恢复、关闭和历史读取、`SessionStore`、`PermissionPolicy`、
审批类型及插件资源释放接口。其他 API 属于 experimental。符号记录定义每个入口的
准确范围。

## 持久数据和配置

文件 Session store 校验 JSONL 事件内容、Session 身份和连续序号，恢复受支持的历史。
未知事件类型和无效内容会被拒绝。末尾缺少换行符的记录视为未完成写入，普通读取时
会修复。`inspect` 读取已提交记录，保持原有文件内容。格式没有全局数字 schema 版本。
Runtime 版本和呈现数据版本分别标识对应内容。

恢复 Session 时，程序比较已保存的 runtime descriptor 和当前运行时。两者不匹配时
需要 `migrateState`；缺少该方法会导致打开失败。恢复状态需要 `restoreState`。
插件状态同样检查 `stateVersion` 和兼容的插件版本；不兼容的已保存状态需要插件
声明的迁移方法，并在使用之前接受校验。

Application 插件快照和模型请求记录当前接受版本 `1`。Catalog 读取程序接受版本
`1` 和 `2`。这些读取程序拒绝未知版本；Session 类的稳定性承诺覆盖已说明的
生命周期 API，各个持久格式遵循自身的读取和迁移规则。

配置使用 JSON Schema 校验，没有全局数字格式版本。未知顶层属性会被拒绝。应用内容
使用应用的 validator。增加版本字段需要相应的格式变更和读取支持。

升级之前，停止全部写入者，保存完整的 Session 和配置数据副本。遵照发布的迁移说明，
执行要求的迁移，校验配置，并使用升级后的读取程序打开现有 Session，随后恢复工作。
当前没有通用格式升级命令。自定义 `SessionStore` 实现管理自身格式版本和迁移流程；
具有版本的格式必须拒绝不支持的版本。持久格式变更需要同时提供兼容性文档、迁移说明
和 changeset。

## 查看 API 范围

[`scripts/api-stability.json`](../../../scripts/api-stability.json)记录每个导出的 package、
entrypoint、symbol、稳定性、引入版本和文档。
生命周期和资源成员使用 `Class.member` 形式的符号名称。
[`api/`](../../../api/)保存具有类型声明的入口的 API Extractor 报告。
其他公共资源的报告记录目标路径和内容 hash。根入口使用
`index.api.md`；子路径的分隔符使用 `__`。JSON 和其他资源导出没有 TypeScript 符号。

构建之后，`pnpm api:check` 比较声明和报告，并校验稳定性记录与 TSDoc 标注。有意修改
API 时，更新符号记录和声明标注，完成构建，运行 `pnpm api:update`，审阅每份报告的差异。详见
[仓库开发](../guides/repository-development.md)。
