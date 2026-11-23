import assert from "node:assert/strict";
import test from "node:test";
import {
  compareBanHacksBaseline,
  compareBoundariesBaseline,
  validateBoundariesBaselineSchema,
  validateExistingBaselineFiles,
} from "./check-baseline-growth.mjs";
import { classifyPackageFile } from "./check-boundaries.mjs";

test("compareBoundariesBaseline allows shrinking and rejects newly added entries", () => {
  const base = {
    relativeEscapes: ["a -> b", "c -> d"],
    typeOnlyCycleEdges: { x: ["y"], y: ["x"] },
  };
  assert.deepEqual(
    compareBoundariesBaseline(base, {
      relativeEscapes: ["a -> b"],
      typeOnlyCycleEdges: { x: ["y"] },
    }),
    [],
  );
  const errors = compareBoundariesBaseline(base, {
    relativeEscapes: ["a -> b", "new -> escape"],
    typeOnlyCycleEdges: { x: ["y"], y: ["z"] },
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /relativeEscapes.*new -> escape/);
  assert.match(errors[1], /typeOnlyCycleEdges.*y -> z/);
});

test("validateBoundariesBaselineSchema rejects malformed local boundaries-baseline.json", () => {
  assert.deepEqual(
    validateBoundariesBaselineSchema({
      relativeEscapes: ["packages/may/test/a.test.mjs -> ../b.js"],
      typeOnlyCycleEdges: { "a.ts": ["b.ts"] },
    }),
    [],
  );
  const errors = validateBoundariesBaselineSchema({
    relativeEscapes: ["packages/may/src/bad.ts -> ../x.js", "packages/may/src/bad.ts -> ../x.js"],
    typeOnlyCycleEdges: ["a.ts -> b.ts"],
  });
  assert.ok(errors.some((e) => /cannot baseline src\/ escape/.test(e)));
  assert.ok(errors.some((e) => /Duplicate relativeEscapes/.test(e)));
  assert.ok(errors.some((e) => /must define object "typeOnlyCycleEdges"/.test(e)));
});

test("compareBanHacksBaseline allows shrinking and rejects added snippets or increased counts", () => {
  const base = {
    asUnknownAs: { "a.ts": ["x as unknown as T"] },
    testPromiseSetTimeout: { "t.mjs": ["new Promise((r) => setTimeout(r, 10))"] },
    nonNullAssertion: { "a.ts": 3 },
  };
  assert.deepEqual(
    compareBanHacksBaseline(base, {
      asUnknownAs: {},
      testPromiseSetTimeout: { "t.mjs": ["new Promise((r) => setTimeout(r, 10))"] },
      nonNullAssertion: { "a.ts": 2 },
    }),
    [],
  );
  const errors = compareBanHacksBaseline(base, {
    asUnknownAs: { "a.ts": ["x as unknown as T", "y as unknown as U"] },
    testPromiseSetTimeout: {
      "t.mjs": ["new Promise((r) => setTimeout(r, 10))", "new Promise((r) => setTimeout(r, 10))"],
    },
    nonNullAssertion: { "a.ts": 4, "b.ts": 1 },
  });
  assert.equal(errors.length, 4);
});

test("validateExistingBaselineFiles rejects deleted file references and invalid counts", () => {
  const errors = validateExistingBaselineFiles({
    asUnknownAs: { "scripts/nonexistent-file-xyz.ts": ["x as unknown as T"] },
    nonNullAssertion: { "package.json": 0 },
    testPromiseSetTimeout: {},
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /deleted file.*nonexistent-file-xyz\.ts/);
  assert.match(errors[1], /positive safe integer/);
});

test("classifyPackageFile allows @sortedyuan/test-support only in root test/ and scripts/, never in src/test/", () => {
  const pkg = { name: "@sortedyuan/may", layer: "L0" };
  assert.deepEqual(classifyPackageFile(pkg, "src/test/helper.ts"), {
    inSrc: true,
    inTest: false,
    inScripts: false,
    isProd: true,
    allowTestSupport: false,
  });
  assert.deepEqual(classifyPackageFile(pkg, "test/unit.test.mjs"), {
    inSrc: false,
    inTest: true,
    inScripts: false,
    isProd: false,
    allowTestSupport: true,
  });
  assert.deepEqual(classifyPackageFile(pkg, "scripts/check.mjs"), {
    inSrc: false,
    inTest: false,
    inScripts: true,
    isProd: false,
    allowTestSupport: true,
  });

  const examplePkg = { name: "@sortedyuan/example", layer: "L4" };
  assert.equal(classifyPackageFile(examplePkg, "basic.mjs").isProd, true);
  assert.equal(classifyPackageFile(examplePkg, "basic.mjs").allowTestSupport, false);
  assert.equal(classifyPackageFile(examplePkg, "scripts/verify.mjs").isProd, false);
  assert.equal(classifyPackageFile(examplePkg, "scripts/verify.mjs").allowTestSupport, true);
});
