import { registry, experiment as original } from "./human-suite.mjs";

export { registry };
export const experiment = {
  ...original,
  evidencePolicy: { ...original.evidencePolicy,
    redactorId: "project-text",
    redactorVersion: "1",
    redact: value => value.replaceAll("private-review-value", "[redacted]"),
  },
};
