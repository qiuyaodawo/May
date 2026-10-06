import { registry, experiment as original } from "../../examples/suite.mjs";

export { registry };
export const experiment = {
  ...original,
  cases: original.cases.map(value => ({ ...value, version: "2" })),
};
