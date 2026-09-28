import type { MaybeCodeController } from "./controller.js";
import type {
  MaybeCodeDelegationRequest,
  MaybeCodeDelegationState,
  MaybeCodeDelegationTask,
} from "./delegation.js";

export const DELEGATION_COMMAND_USAGE =
  "/delegations [show|tools <task-id>|resolve <task-id> <failed|cancelled> <finding>]";

/** 按时间倒序列出本工作区的子 Agent 请求。 */
export function formatDelegationRequests(
  requests: readonly MaybeCodeDelegationRequest[],
  active?: MaybeCodeDelegationState,
): string {
  if (requests.length === 0 && active === undefined) {
    return "No sub-agent request has run in this session yet.";
  }
  const sections: string[] = [];
  if (active !== undefined) sections.push(renderRequest(active, "current request"));
  for (const request of requests) {
    if (active !== undefined && request.requestId === active.requestId) continue;
    sections.push(renderRequest(request, "earlier request"));
  }
  return sections.join("\n\n");
}

/** 一个子 Agent Session 的工具记录，按执行顺序。 */
export async function formatDelegationToolRecords(
  controller: MaybeCodeController,
  taskId: string,
): Promise<string> {
  if (controller.delegationToolRecords === undefined) {
    throw new Error("Sub-agents are disabled in this workspace");
  }
  const records = await controller.delegationToolRecords(taskId);
  if (records.records.length === 0) {
    return `Task ${taskId} (${records.sessionId}) has no finished tool records.`;
  }
  return [
    `Task ${taskId} · Session ${records.sessionId}`,
    ...records.records.map((record) =>
      `  step ${record.step} ${record.status} ${record.name}: ${record.summary.replace(/\s+/gu, " ").slice(0, 160)}`),
    records.truncated ? "  … more records were omitted" : "",
  ].filter((line) => line !== "").join("\n");
}

/**
 * 为一个中断的子任务记录已经核对的结论。
 *
 * 由操作者说明核对结果；任何子 Agent 工具都不会被重放。
 */
export async function executeDelegationCommand(
  arguments_: readonly string[],
  controller: MaybeCodeController,
): Promise<string> {
  if (controller.listDelegationRequests === undefined) {
    return "Sub-agents are disabled in this workspace.";
  }
  const requests = controller.listDelegationRequests();
  const verb = arguments_[0];
  if (arguments_.length === 0 || verb === "show") {
    return formatDelegationRequests(requests, controller.getDelegationState?.());
  }
  if (verb === "tools") {
    if (arguments_.length !== 2) throw new Error(DELEGATION_COMMAND_USAGE);
    return await formatDelegationToolRecords(controller, arguments_[1]!);
  }
  if (verb === "resolve") {
    const status = arguments_[2];
    if (arguments_.length < 4 || (status !== "failed" && status !== "cancelled")) {
      throw new Error(DELEGATION_COMMAND_USAGE);
    }
    const taskId = arguments_[1]!;
    const finding = arguments_.slice(3).join(" ").trim();
    if (finding === "") throw new Error("A verified recovery finding is required");
    if (controller.resolveDelegationRecovery === undefined) {
      throw new Error("Sub-agents are disabled in this workspace");
    }
    const request = requests.find((entry) => entry.tasks.some((task) => task.id === taskId));
    if (request === undefined) throw new Error(`Unknown sub-agent task: ${taskId}`);
    await controller.resolveDelegationRecovery(request.requestId, taskId, finding, { status, detail: finding });
    return `Recorded a verified ${status} outcome for ${taskId}. No sub-agent tool was replayed.`;
  }
  throw new Error(DELEGATION_COMMAND_USAGE);
}

/** 按深度和 id 排序的任务列表。 */
export function delegationOrder(
  tasks: readonly MaybeCodeDelegationTask[],
): readonly MaybeCodeDelegationTask[] {
  return [...tasks].sort((left, right) => left.depth - right.depth || left.id.localeCompare(right.id));
}

/** 一行任务状态，包含父子关系、文件、Run 与结果摘要。 */
export function renderDelegationTask(task: MaybeCodeDelegationTask): string {
  const indent = "  ".repeat(Math.max(0, task.depth - 1));
  const parts = [`${indent}${task.id} [${task.role}] ${task.status}`];
  if (task.parentTaskId !== undefined) parts.push(`parent ${task.parentTaskId}`);
  if (task.files !== undefined && task.files.length > 0) parts.push(`files ${task.files.join(", ")}`);
  if (task.changedFiles !== undefined && task.changedFiles.length > 0) {
    parts.push(`changed ${task.changedFiles.join(", ")}`);
  }
  if (task.runId !== undefined) parts.push(`run ${task.runId}`);
  if (task.usage?.totalTokens !== undefined) parts.push(`${task.usage.totalTokens} tokens`);
  if (task.detail !== undefined) parts.push(`- ${task.detail}`);
  if (task.output !== undefined) {
    parts.push(`\n${indent}    result: ${task.output.replace(/\s+/gu, " ").slice(0, 400)}`);
  }
  return parts.join(" ");
}

/** 请求启动或结束时的整棵树与请求用量。 */
export function formatDelegationTree(state: MaybeCodeDelegationState): string {
  const lines = [
    `request ${state.requestId} ${state.status}`,
    ...delegationOrder(state.tasks).map((task) => renderDelegationTask(task)),
  ];
  if (state.budget !== undefined) {
    lines.push(
      `request budget: ${state.budget.modelCalls}/${state.budget.maxModelCalls} model calls, ` +
      `${state.budget.totalTokens} tokens${state.budget.usageComplete ? "" : " (some calls reported no usage or were charged by reservation)"}`,
    );
  }
  return lines.join("\n");
}

function renderRequest(
  request: MaybeCodeDelegationRequest | MaybeCodeDelegationState,
  label: string,
): string {
  const lines = [`${label} ${request.requestId} · ${request.status}`];
  if (request instanceof Object && "mainRunIds" in request && request.mainRunIds.length > 0) {
    lines.push(`  main Session Runs: ${request.mainRunIds.join(", ")}`);
  }
  for (const task of delegationOrder(request.tasks)) {
    lines.push(`  ${renderDelegationTask(task)}`);
  }
  if ("budget" in request && request.budget !== undefined) {
    lines.push(`  request budget: ${request.budget.modelCalls}/${request.budget.maxModelCalls} model calls, ` +
      `${request.budget.totalTokens} tokens${request.budget.usageComplete ? "" : " (some calls reported no usage or were charged by reservation)"}`);
  }
  return lines.join("\n");
}
