export function createUiTasks(report?: (error: unknown) => void) {
  const tasks = new Set<Promise<void>>();
  const errors: unknown[] = [];
  return {
    run(task: Promise<unknown>): void {
      const pending = task.then(
        () => {
          tasks.delete(pending);
        },
        (error: unknown) => {
          tasks.delete(pending);
          if (report) report(error);
          else errors.push(error);
        },
      );
      tasks.add(pending);
    },
    async close(): Promise<void> {
      while (tasks.size) await Promise.all([...tasks]);
      if (errors.length) throw new AggregateError(errors, "UI background tasks failed");
    },
  };
}
