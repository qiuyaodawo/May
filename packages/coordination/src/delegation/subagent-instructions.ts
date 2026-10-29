import type { MaybeCodeSubagentConfiguration, MaybeCodeSubagentRole } from "./subagents.js";

/** 主 Agent 可用委派工具时提供的协作指导。 */
export function delegationInstructions(
  configuration: MaybeCodeSubagentConfiguration,
  available: boolean,
): string {
  if (!available) return "";
  const roles = configuration.roles
    .map((role) => `- ${role.name}: tools ${role.tools.join(", ")}; may delegate to ${role.delegateTo.length === 0 ? "no role" : role.delegateTo.join(", ")}${role.model === undefined ? "" : `; model profile ${role.model}`}`)
    .join("\n");
  const limits = configuration.limits;
  return `# Delegation context

Each child runs in its own Session and receives only its task brief.
Children share the workspace and may read any workspace file. Assign file ownership explicitly.
The edit and write tools enforce assigned paths, require a prior read of existing files, and reject changes to files modified since that read.
The shell can modify any workspace file, so include its permitted file scope in the brief.
File guards cover this application's operations; changes by other processes are detected on the next operation and cannot be prevented.
Assess child outcomes and produce the final response. Report failures and cancellations as missing results.

Available roles:
${roles}

Current limits:
Delegation depth: ${limits.maxDepth} tasks, including the main agent at depth 1.
Task count: ${limits.maxTasks} tasks per request.`;
}

/** 基于宿主基础指令构造的单个子 Agent 系统指令。 */
export function subagentInstructions(options: {
  readonly base: string;
  readonly role: MaybeCodeSubagentRole;
  readonly workspace: string;
  readonly maxDepthReached: boolean;
  readonly files?: readonly string[];
}): string {
  const { base, role, maxDepthReached, files } = options;
  return `${base}

# Assigned task

Work on the assignment provided by the parent agent.
Your Session cannot see the parent's conversation or other children's contexts.
Read the files needed for your assignment; the workspace is shared.
Modify only assigned files, including when using the shell.
Read existing files before editing. If a file changes during your work, read its current contents before continuing.
File guards cover this application's operations; changes made by other processes are detected on the next operation.

Your final report is the result delivered to the parent.
Include the answer or changes, supporting evidence, verification results, and remaining limitations.
Report only actions and results you observed.
Activate skills needed by the assignment in your own Session.

Assigned role: ${role.name}
${role.instructions === undefined ? "" : `\nRole guidance:\n${role.instructions}\n`}
Assigned files:
${files === undefined ? "Use the file assignments in your task brief." : files.length === 0 ? "No files assigned for modification." : files.join("\n")}

Delegation permissions:
${maxDepthReached
    ? "The request has reached its nesting limit; delegation is unavailable."
    : role.delegateTo.length === 0
      ? "This role has no authorized delegation targets."
      : `Authorized roles: ${role.delegateTo.join(", ")}. Use delegate_tasks with a complete standalone brief.`}`;
}
