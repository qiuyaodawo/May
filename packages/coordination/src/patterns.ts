import type { TaskSpec } from "./types.js";

/** A chain is a graph, not a separate execution engine. */
export function pipeline(tasks: readonly Omit<TaskSpec, "dependsOn">[]): TaskSpec[] {
  return tasks.map((task, index) => ({ ...task, dependsOn: index === 0 ? [] : [tasks[index - 1]!.id] }));
}

/** All workers must succeed. Their explicit answers become the reducer's input. */
export function parallelTasks(workers: readonly Omit<TaskSpec, "dependsOn">[],
  reducer: Omit<TaskSpec, "dependsOn">): TaskSpec[] {
  return [...workers.map((task) => ({ ...task, dependsOn: [] })), { ...reducer, dependsOn: workers.map((task) => task.id) }];
}
