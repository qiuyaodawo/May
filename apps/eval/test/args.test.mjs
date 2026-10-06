import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "../dist/index.js";

test("accepts explicit command flags and variant selectors", () => {
  assert.deepEqual(parseCliArgs(["run", "--suite", "suite.mjs", "--output", ".eval-results"]), {
    command: "run", options: { suite: "suite.mjs", output: ".eval-results" },
  });
  assert.equal(parseCliArgs(["compare", "--baseline", "baseline", "--candidate", "candidate", "--candidate-variant", "optimized"]).options["candidate-variant"], "optimized");
  assert.equal(parseCliArgs(["grade", "--experiment", "out", "--trial", "trial-1", "--evaluator", "human", "--result", "review.json", "--suite", "suite.mjs"]).options.suite, "suite.mjs");
  assert.equal(parseCliArgs([]), undefined);
  assert.equal(parseCliArgs(["--help"]), undefined);
});

test("rejects missing, duplicated, unknown and positional inputs", () => {
  assert.throws(() => parseCliArgs(["run", "--suite", "suite.mjs"]), /--output is required/);
  assert.throws(() => parseCliArgs(["run", "--suite", "a", "--suite", "b", "--output", "out"]), /only be specified once/);
  assert.throws(() => parseCliArgs(["report", "--experiment", "a", "--unknown", "b"]), /Unknown option/);
  assert.throws(() => parseCliArgs(["validate", "suite.mjs"]), /Unexpected argument/);
  assert.throws(() => parseCliArgs(["unknown"]), /Unknown evaluation command/);
});
