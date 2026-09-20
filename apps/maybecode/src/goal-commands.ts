import type { GoalBudget, GoalState } from "@may/goal";
import type { MaybeCodeController } from "./controller.js";

export const GOAL_COMMAND_USAGE = "/goal [status|start [--max-runs N] [--tokens N] [--duration-ms N] -- <objective>|pause|resume|cancel]";

export function parseGoalStart(arguments_: readonly string[]): { objective: string; budget: GoalBudget } {
  let index = 0;
  const budget: { maxRuns?: number; maxTotalTokens?: number; maxDurationMs?: number } = {};
  const fields = { "--max-runs": "maxRuns", "--tokens": "maxTotalTokens", "--duration-ms": "maxDurationMs" } as const;
  while (index < arguments_.length && arguments_[index]!.startsWith("--")) {
    const option = arguments_[index++]!;
    if (option === "--") break;
    if (!(option in fields)) throw new Error(`Unknown goal option: ${option}`);
    const field = fields[option as keyof typeof fields];
    const text = arguments_[index++];
    if (text === undefined || !/^\d+$/u.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) throw new Error(`${option} requires a positive safe integer`);
    if (budget[field] !== undefined) throw new Error(`Duplicate goal option: ${option}`);
    budget[field] = Number(text);
  }
  const objective = arguments_.slice(index).join(" ").trim();
  if (!objective) throw new Error(GOAL_COMMAND_USAGE);
  return { objective, budget };
}

export async function executeGoalCommand(arguments_: readonly string[], app: MaybeCodeController): Promise<string> {
  if (!app.getGoal) throw new Error("This controller does not support goals");
  const [verb = "status", ...rest] = arguments_;
  if (verb === "start") {
    if (!app.startGoal) throw new Error("This controller cannot start goals");
    const { objective, budget } = parseGoalStart(rest);
    return formatGoal(await app.startGoal(objective, budget));
  }
  if (rest.length) throw new Error(GOAL_COMMAND_USAGE);
  if (verb === "status") return formatGoal(app.getGoal());
  const method = verb === "pause" ? app.pauseGoal : verb === "resume" ? app.resumeGoal : verb === "cancel" ? app.cancelGoal : undefined;
  if (!method) throw new Error(GOAL_COMMAND_USAGE);
  return formatGoal(await method.call(app));
}

export function formatGoal(goal: GoalState | undefined): string {
  if (!goal) return "No goal has been created.";
  return [`Goal: ${goal.objective}`, `Status: ${goal.status}`, `ID: ${goal.id}`,
    `Runs: ${goal.usage.runs}/${goal.budget.maxRuns ?? "unlimited"}`,
    `Tokens: ${goal.usage.totalTokens}/${goal.budget.maxTotalTokens ?? "unlimited"}${goal.usage.usageComplete ? "" : " (usage incomplete)"}`,
    `Active time: ${goal.usage.elapsedMs}/${goal.budget.maxDurationMs ?? "unlimited"} ms`,
    ...(goal.progress ? [`Progress: ${goal.progress}`] : []),
    ...(goal.reason ? [`Reason: ${goal.reason}`] : []),
    ...(goal.completion ? [`Completion (${goal.completion.source}): ${goal.completion.evidence}`] : []),
  ].join("\n");
}
