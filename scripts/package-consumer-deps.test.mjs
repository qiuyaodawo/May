import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  discoverWorkspacePackages,
  resolveConsumerTestDependencies,
  resolvePublishableRuntimeClosure,
} from "./package-consumer-deps.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));

test("derives exact transitive runtime closures for eval, scheduler, and plugin targets", async () => {
  const packages = await discoverWorkspacePackages(repository);
  const evalClosure = resolvePublishableRuntimeClosure(packages, ["@sortedyuan/eval"]);
  for (const expected of [
    "@sortedyuan/may",
    "@sortedyuan/coding-tools",
    "@sortedyuan/mcp",
    "@sortedyuan/coordination",
    "@sortedyuan/observability",
    "@sortedyuan/eval",
  ]) {
    assert.ok(evalClosure.includes(expected), `missing ${expected} in eval closure`);
  }
  assert.equal(evalClosure.at(-1), "@sortedyuan/eval");

  const schedulerClosure = resolvePublishableRuntimeClosure(packages, ["@sortedyuan/scheduler"]);
  assert.deepEqual(schedulerClosure, ["@sortedyuan/may", "@sortedyuan/scheduler"]);

  const pluginClosure = resolvePublishableRuntimeClosure(packages, [
    "@sortedyuan/may",
    "@sortedyuan/coordination",
    "@sortedyuan/mcp",
    "@sortedyuan/observability",
    "@sortedyuan/gateway",
  ]);
  assert.ok(pluginClosure.includes("@sortedyuan/media"), "must include transitive @sortedyuan/media for gateway");
  assert.ok(
    pluginClosure.includes("@sortedyuan/coding-tools"),
    "must include transitive @sortedyuan/coding-tools for coordination",
  );
});

test("rejects private workspace runtime dependencies and automatically picks up new transitive deps (216f7aa)", () => {
  const synthetic = new Map([
    [
      "@sortedyuan/a",
      {
        name: "@sortedyuan/a",
        directory: join(repository, "packages/a"),
        relativeDirectory: "packages/a",
        manifest: { name: "@sortedyuan/a", private: false, dependencies: { "@sortedyuan/b": "workspace:*" } },
      },
    ],
    [
      "@sortedyuan/b",
      {
        name: "@sortedyuan/b",
        directory: join(repository, "packages/b"),
        relativeDirectory: "packages/b",
        manifest: { name: "@sortedyuan/b", private: false, dependencies: { "@sortedyuan/c": "workspace:*" } },
      },
    ],
    [
      "@sortedyuan/c",
      {
        name: "@sortedyuan/c",
        directory: join(repository, "packages/c"),
        relativeDirectory: "packages/c",
        manifest: { name: "@sortedyuan/c", private: false, dependencies: {} },
      },
    ],
    [
      "@sortedyuan/priv",
      {
        name: "@sortedyuan/priv",
        directory: join(repository, "packages/priv"),
        relativeDirectory: "packages/priv",
        manifest: { name: "@sortedyuan/priv", private: true, dependencies: {} },
      },
    ],
  ]);

  assert.deepEqual(resolvePublishableRuntimeClosure(synthetic, ["@sortedyuan/a"]), [
    "@sortedyuan/c",
    "@sortedyuan/b",
    "@sortedyuan/a",
  ]);

  synthetic.get("@sortedyuan/c").manifest.dependencies = { "@sortedyuan/priv": "workspace:*" };
  assert.throws(
    () => resolvePublishableRuntimeClosure(synthetic, ["@sortedyuan/a"]),
    /not a publishable workspace package: @sortedyuan\/priv/,
  );
});

test("resolves private devDependencies via link: and rejects unpacked public test deps (a5414ad)", async () => {
  const packages = await discoverWorkspacePackages(repository);
  const consumer = join(repository, "..", "external-consumer-test");
  const packed = resolvePublishableRuntimeClosure(packages, ["@sortedyuan/may"]);

  const deps = resolveConsumerTestDependencies(
    packages,
    packed,
    ["packages/may/test/services/models.test.mjs"],
    repository,
    consumer,
  );
  assert.ok(deps.get("@sortedyuan/test-support")?.startsWith("link:"), "private test-support must resolve via link:");

  const synthetic = new Map(packages);
  synthetic.set("@sortedyuan/may", {
    ...packages.get("@sortedyuan/may"),
    manifest: {
      ...packages.get("@sortedyuan/may").manifest,
      devDependencies: {
        ...packages.get("@sortedyuan/may").manifest.devDependencies,
        "@sortedyuan/providers": "workspace:*",
      },
    },
  });
  assert.throws(
    () =>
      resolveConsumerTestDependencies(
        synthetic,
        packed,
        ["packages/may/test/services/models.test.mjs"],
        repository,
        consumer,
      ),
    /public package outside the packed chain/,
  );
});
