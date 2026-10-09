# Create and activate Agent Skills

**English** | [简体中文](../../zh-CN/guides/skills.md)

`@may/skills` implements the [Agent Skills format](https://agentskills.io/specification)
for general agents. Use this guide to create a local skill, discover it in
MaybeCode, and activate it for a Session. Start in the project directory used
by the configured MaybeCode host.

## 1. Create the skill and its reference

Create `.agents/skills/research/SKILL.md`:

```markdown
---
name: research
description: Research a topic using primary sources and provide cited findings.
---
Read references/guide.md. Compare primary evidence and explain uncertainty.
```

Create `.agents/skills/research/references/guide.md` with the referenced guidance:

```markdown
Use original project documentation and source code when researching software.
Record the source of each factual claim. State which results were verified.
```

Supporting files may live in `references/`, `scripts/`, `assets/` or other skill
subdirectories. Names match their directory and use lowercase ASCII letters,
digits and single hyphens, maximum 64 characters. Descriptions are non-empty,
maximum 1024 characters. Standard license, compatibility, metadata and experimental
allowed-tools fields are parsed. Empty bodies, aliases, duplicate YAML keys,
unknown tags and invalid field types are rejected.

<a id="discovery-and-commands"></a>

## 2. Discover and activate the skill

Configured MaybeCode (including CLI) scans `~/.agents/skills`, `~/.may/skills`,
`<workspace>/.agents/skills`, then `<workspace>/.may/skills`. Later roots override
earlier names with diagnostics. Programmatic `MaybeCodeApplication.open()` and
`MaybeCodeWorkspace.open()` scan only workspace roots by default. Supply
`skillDirectories`, an immutable `skills: SkillRegistry`, or `skills: false`.
`openConfiguredMaybeCode()` uses all four defaults.

Set `apps.maybecode.skills` to `false` to disable, or to
`{ "directories": ["./skills", "~/skills"] }` to replace defaults. Relative
config paths use the config directory; `~` expands to home. Empty arrays disable
discovery. Missing roots are ignored; invalid skills appear in diagnostics.
Newly opened sessions rediscover directory-based skills. Injected registries
remain caller-owned snapshots.

Open a new Session and execute `/skills`. Confirm `research` is listed without
diagnostics, inspect its body with `/skills show research`, and activate it
with `/skills use research`. Both terminal UIs support:

- `/skills`: list names, descriptions, locations, active status and diagnostics.
- `/skills show <name>`: preview body/revision without activation or model calls.
- `/skills use <name>`: activate for this session without invoking the model.
- `/skills use <name> <task>`: activate and submit to the same session.
- Tab completion for subcommands and names.

The model initially receives only catalog summaries, then selects a matching
skill or follows a user's named request with `skill_read {name}`. Load supporting
UTF-8 files with `skill_read {name, path: "references/guide.md"}`. Returned absolute
directories let existing approved execution tools use scripts/binary assets;
skill_read itself only reads text.

## 3. Verify saved activation

Execute `/instructions` and confirm the active skill guidance is included.
Close and reopen the same Session to confirm the saved revision remains active.
A new Session starts with no active skills. Updating directory-based files
requires rediscovery in a newly opened Session.

## State and permissions

Activation is serialized and deduplicated. `AgentApplication` first persists
the full snapshot as `state.updated` under `may.skills.active.v1`, then publishes
it. Default Context snapshots and inspection include active instructions outside
compactable messages. Activation invalidates old token measurements. Reopening
restores original content/revision even when files change or disappear. New
sessions start with no active skills; `/instructions` includes current guidance.
Resource reads reject changed revisions/locations; use a new session to adopt
updated directory-based skills. Disabling skills prevents restoring their prompt.

Skill guidance remains subordinate to host/user instructions. `allowed-tools`
is metadata only and grants no permissions. MaybeCode's bounded skill_read is
approval-free, but scripts still use existing shell/MCP permissions. Loading
never executes scripts or installs dependencies.

Bounds: 32 roots, 512 entries per root, 128 skills, 64 KiB per SKILL.md, 256 KiB
per resource and 256 KiB of active snapshots. Reads reject absolute paths,
traversal, alternate data streams, symbolic/junction links and hard-linked files.
They validate UTF-8, bound reads and check file identity. This is neither a process
sandbox nor a remote skill marketplace; choose sources appropriate for your host.

## Generic integration

Add `@may/skills` and `@may/application` as direct application dependencies.
This snippet assumes `model`, `tools`, `permissionPolicy`, and `store` are
initialized. Replace `/srv/agent-skills` with the directory containing your
skill directories, and close the application after execution:

```ts
import { SkillRegistry } from "@may/skills";
import { defineAgent } from "@may/application";

const skills = await SkillRegistry.discover(["/srv/agent-skills"]);
const definition = defineAgent({ model, tools, skills, permissionPolicy });
const app = await definition.open({ store });
try {
  await app.activateSkill("research");
  await (await app.submit({ input: "Research the topic" })).result;
} finally {
  await app.close();
}
```

Manual integration uses SkillSession's `readTool()`, `instructions()`, `setSink()`,
`restore()` and `listActive()`. Each agent Session needs its own SkillSession.
Custom Context factories must honor `ContextFactoryOptions.instructionsSource`
in both model snapshots and inspection, and implement `invalidateMeasurement()`
when caching usage. The compatibility `instructions` field is only an initial
snapshot and cannot reflect later activations on its own.
