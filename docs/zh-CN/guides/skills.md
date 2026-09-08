# Agent Skills

[English](../../en/guides/skills.md)

`@may/skills` 为通用 agent 实现
[Agent Skills 格式](https://agentskills.io/specification)。创建
`.agents/skills/research/SKILL.md`：

```markdown
---
name: research
description: 使用一手来源研究主题，并提供带引用的结论。
---
阅读 references/guide.md。比较一手证据，说明不确定性。
```

配套文件可放在 `references/`、`scripts/`、`assets/` 或其他 skill 子目录。
名称必须匹配目录，使用小写 ASCII 字母、数字和单个连字符，最多 64 字符；
描述非空且最多 1024 字符。支持标准 license、compatibility、metadata 和实验性
allowed-tools 字段。拒绝空正文、YAML 别名、重复键、未知标签及错误字段类型。

## 发现和命令

使用配置的 MaybeCode（含 CLI）依次扫描 `~/.agents/skills`、`~/.may/skills`、
`<workspace>/.agents/skills` 和 `<workspace>/.may/skills`，后面的同名项覆盖前面并
记录诊断。直接调用 `MaybeCodeApplication.open()` / `MaybeCodeWorkspace.open()`
默认仅扫描工作区目录，可传 `skillDirectories`、不可变的 `skills: SkillRegistry`
或 `skills: false`。`openConfiguredMaybeCode()` 使用全部四个默认目录。

`apps.maybecode.skills` 设为 `false` 可禁用，也可用
`{ "directories": ["./skills", "~/skills"] }` 替换默认目录。配置中的相对路径
以配置文件目录为基准，`~` 展开为用户目录。空数组关闭发现，不存在的根目录会忽略，
无效 skill 出现在诊断中。新打开会话会重新发现目录型 skills；注入 registry 则由
调用方管理其快照。

两个终端界面均支持：

- `/skills`：列出名称、描述、位置、激活状态和诊断。
- `/skills show <name>`：查看正文／版本，不激活、不调用模型。
- `/skills use <name>`：为当前会话激活，不调用模型。
- `/skills use <name> <task>`：激活并向同一会话提交任务。
- Tab 补全子命令和名称。

模型最初只收到目录摘要，再按任务或用户指定名称调用 `skill_read {name}`。
配套 UTF-8 文件通过 `skill_read {name, path: "references/guide.md"}` 加载。
返回的绝对目录可用于已有获准执行工具读取脚本／二进制资产，skill_read 本身只读文本。

## 状态和权限

激活会串行化并去重。`AgentApplication` 先通过 `state.updated` 将完整快照保存到
`may.skills.active.v1`，然后发布激活状态。默认 Context 的模型快照和检查把激活指令
放在可压缩消息之外，激活会使旧 token 测量失效。重开会话恢复原内容和版本，即使文件
更改或消失。新会话没有激活项；`/instructions` 显示当前指导。资源读取拒绝版本／位置
变化，通过新会话采纳目录型 skill 更新。禁用后不会恢复 skill 到提示中。

Skill 指导服从宿主和用户指令。`allowed-tools` 仅是元数据，不授予权限。
MaybeCode 的受限 skill_read 免审批，脚本仍经过既有 shell／MCP 权限。
加载不会执行脚本或安装依赖。

限制：最多 32 个根目录，每根 512 个条目，共 128 个 skill；每个 SKILL.md 64 KiB，
每份资源 256 KiB，激活快照合计 256 KiB。拒绝绝对路径、目录穿越、备用数据流、
符号／junction 链接和硬链接；验证 UTF-8、限制读取量并检查文件身份。
它不是进程沙箱或远程 skill 市场，请选择适合宿主信任范围的来源。

## 通用集成

```ts
import { SkillRegistry } from "@may/skills";
import { defineAgent } from "@may/application";

const skills = await SkillRegistry.discover(["/srv/agent-skills"]);
const definition = defineAgent({ model, tools, skills, permissionPolicy });
const app = await definition.open({ store });
await app.activateSkill("research");
await (await app.submit({ input: "研究指定主题" })).result;
```

手动集成可用 SkillSession 的 `readTool()`、`instructions()`、`setSink()`、`restore()`
和 `listActive()`。每个 agent Session 需要独立 SkillSession。自定义 Context 工厂
必须在模型快照和检查中支持 `ContextFactoryOptions.instructionsSource`，缓存用量时
还应实现 `invalidateMeasurement()`。兼容字段 `instructions` 仅是初始快照，单独使用
无法反映后续激活。
