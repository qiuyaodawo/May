import { fileURLToPath } from "node:url";
import { createNodeCommandExecutionAdapter } from "@may/eval";
import { registry, experiment as original } from "../../examples/suite.mjs";

registry.registerExecution(createNodeCommandExecutionAdapter({
  id: "failing-command",
  version: "1",
  command: context => ({ script: fileURLToPath(new URL("./fail-command.mjs", import.meta.url)), cwd: context.target.workspacePath }),
}));

export { registry };
export const experiment = {
  ...original,
  repetitions: 1,
  concurrency: 1,
  variants: [{ id: "failing-command", version: "1", execution: { id: "failing-command", version: "1" }, configuration: {} }],
};
