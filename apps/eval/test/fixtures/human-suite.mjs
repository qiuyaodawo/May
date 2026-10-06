import { createHumanEvaluator } from "@may/eval";
import { registry, experiment as original } from "../../examples/suite.mjs";

registry.registerEvaluator(createHumanEvaluator("artifact-review", "1"));

export { registry };
export const experiment = {
  ...original,
  repetitions: 1,
  concurrency: 1,
  cases: original.cases.map(value => ({ ...value, evaluators: [...value.evaluators, { id: "artifact-review", version: "1", required: true }] })),
};
