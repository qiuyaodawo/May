import { fileURLToPath } from "node:url";
import { createCommandExecutionAdapter } from "@may/eval";
import { registry, experiment as original } from "../../examples/suite.mjs";

registry.registerExecution(createCommandExecutionAdapter({
  id: "unconfirmed-command",
  version: "1",
  command: context => ({ executable: process.execPath,
    args: [fileURLToPath(new URL("../../examples/write-artifact.mjs", import.meta.url))],
    cwd: context.target.workspacePath }),
}));

export { registry };
export const experiment = {
  ...original,
  repetitions: 1,
  concurrency: 1,
  variants: [{ id: "unconfirmed-command", version: "1", execution: { id: "unconfirmed-command", version: "1" }, configuration: {} }],
};
