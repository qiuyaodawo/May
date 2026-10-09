# MaybeCode instruction composition

[简体中文](../../zh-CN/guides/maybecode-instructions.md)

The built-in base prompt identifies MaybeCode, names its coding responsibilities,
asks for the deliverable and completion conditions, and provides information
handling and communication guidance. `instructionsDirectory/system.md` or an
explicit `instructions` value replaces this base prompt for the application.

## Sources and order

| Order | Source | Availability |
| --- | --- | --- |
| -100 | Base prompt | Every request |
| -80 | Current environment | Every request |
| -60 | Project rule chain from the project root through the workspace, with absolute source paths | When present |
| -40 | Tool-use guidance | Every request |
| 0 | Skill metadata and activated documents | When Skills are available |
| 20 | Delegation context or child assignment | When delegation is available, or for a child |
| 40 | Goal objective, progress and execution guidance | While a Goal is active |
| 60 | Context continuity guidance | In history-reference mode |

`InstructionSources` assembles contributions by `order`, plugin composition order,
then registration order. Plugins register their own guidance; tool descriptions
and parameter schemas use the model request's tool definitions.

## Project rule discovery

The workspace is the application's starting directory. MaybeCode searches
upward for the nearest `.git` file or directory, then visits the directories
from that project root through the workspace. A worktree's `.git` file also
identifies a project root. Without a marker, only the workspace directory is
searched. Discovery does not visit sibling directories, descendants of the
workspace, or ancestors above the nearest project root.

Each directory contributes at most one nonempty instruction file: first
`AGENTS.override.md`, then `AGENTS.md`. Missing and empty files are skipped.
Selected documents enter the project contribution in parent-to-child order.
Each document retains its absolute `Source` path; multiple documents also
identify their directory scope and specify that deeper-directory rules take
priority when project rules conflict. Parent rules continue to apply within
their scope.

For example, starting in `repo/packages/web` with a `.git` marker in `repo`
can load `repo/AGENTS.md`, `repo/packages/AGENTS.md`, and
`repo/packages/web/AGENTS.md`. A nonempty
`repo/packages/web/AGENTS.override.md` takes priority over that directory's
`AGENTS.md`. Starting in `repo` searches only the project root.

Each document and the combined project document bodies, including separating
blank lines, have a 32 KiB limit. Invalid UTF-8, oversized content, and unsafe
symbolic links, reparse points, or hard links stop loading. Ancestor rule
discovery does not change the workspace used by coding tools or their
permission policy.

Library hosts using `@may/coding-tools/instructions` can configure
`projectRootMarkers` (default `[".git"]`), `projectInstructionsFilename`
(default `AGENTS.md`), and `projectInstructionsFallbackFilenames` (default
`[]`). `projectRootMarkers: []` searches only the workspace.
`projectInstructionsFilename: false` disables the complete project chain.
`CodingInstructions.projects` exposes every selected document in order;
`project` retains the closest selected directory's document. Use `projects`
or `effective` for the complete content, or
`formatCodingProjectInstructions(projects, label?)` to format the project
section separately. These options belong to the library loader; MaybeCode
uses its defaults.

## Environment and project updates

Runtime fields report the absolute workspace, operating system, actual shell,
Agent role, Session origin and current permission mode. The shell name appears
once; syntax guidance follows the environment fields. A historical branch can
identify its source Session. Child environments identify the assigned role and
parent task and use their own available tools.

The complete project rule chain is rediscovered on application opening,
accepted user input (including steering), and Run startup. The next Context
snapshot uses the refreshed content. Child Sessions use the same project source
and refresh callback, with their assignment provided separately. The selected
base prompt remains fixed until the application is reopened.

Changing instruction contributions invalidates the current provider token
measurement. MaybeCode discards previous measurements on runtime recreation;
current Context estimates apply until new provider usage is available.

## Conditional guidance

Skill metadata contains names, descriptions and compatibility requirements.
`skill_read` activates the full document or reads referenced resources as needed.
Activated documents remain in that Session's instruction contributions.

The delegation tool describes independent task submission and result delivery.
Additional guidance provides shared workspace requirements, roles and limits.
Each child's instructions include file assignments and its report requirements.

Goal guidance contributes current state through its plugin. A short continuation
reminder is included in Context accounting and placed at the end of the actual
model request. History-reference mode provides note-saving and Context-reset
guidance, plus saved work state after a reset.

`/instructions` displays the current instruction contributions. The final Goal
reminder is supplied separately during model request preparation.
