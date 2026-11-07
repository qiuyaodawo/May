import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import semver from "semver";
import { repository, runPnpm } from "./release-utils.mjs";

const { values } = parseArgs({
  options: {
    registry: { type: "string", default: "https://registry.npmjs.org" },
    tag: { type: "string", default: "latest" },
    manifest: { type: "string", default: "scripts/release-packages.json" },
    "expect-published": { type: "boolean", default: false },
  },
});
const registry = new URL(values.registry);
assert.ok(["https:", "http:"].includes(registry.protocol), "Registry must use HTTP or HTTPS");
assert.ok(
  !registry.username && !registry.password && !registry.search && !registry.hash,
  "Use a registry URL without credentials, query or fragment",
);
assert.ok(values.tag.trim().length > 0, "Tag must not be empty");
if (!registry.pathname.endsWith("/")) registry.pathname += "/";
const names = JSON.parse(await readFile(resolve(repository, values.manifest), "utf8"));
assert.ok(
  Array.isArray(names) && names.every((name) => typeof name === "string"),
  "Manifest must contain package names",
);
assert.equal(new Set(names).size, names.length, "Manifest contains duplicate packages");
const projects = JSON.parse(runPnpm(["list", "--recursive", "--depth", "-1", "--json"]));
const manifests = new Map();
for (const project of projects) {
  const manifest = JSON.parse(await readFile(join(project.path, "package.json"), "utf8"));
  manifests.set(manifest.name, manifest);
}
for (const name of names) assert.ok(manifests.has(name), `Missing workspace package: ${name}`);

const queries = new Map();
async function query(name) {
  if (!queries.has(name)) queries.set(name, fetchMetadata(name));
  return queries.get(name);
}

async function fetchMetadata(name) {
  const [request] = await Promise.allSettled([
    fetch(new URL(encodeURIComponent(name), registry), {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(30_000),
    }),
  ]);
  if (request.status === "rejected") {
    const code = request.reason?.cause?.code ?? request.reason?.code ?? request.reason?.name;
    return { error: `network failure${code ? ` (${code})` : ""}` };
  }
  const response = request.value;
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 404) return { error: "package not found (HTTP 404)", notFound: true };
    if (response.status === 401 || response.status === 403) {
      return { error: `authentication failed (HTTP ${response.status})` };
    }
    return { error: `registry request failed (HTTP ${response.status})` };
  }
  const [body] = await Promise.allSettled([response.json()]);
  if (body.status === "rejected") {
    return {
      error:
        body.reason instanceof SyntaxError
          ? "registry response contains invalid JSON"
          : "network failure while reading registry response",
    };
  }
  assert.ok(body.value && typeof body.value === "object", `Invalid registry metadata for ${name}`);
  assert.ok(body.value.versions && typeof body.value.versions === "object", `Missing registry versions for ${name}`);
  return { metadata: body.value };
}

let mismatches = 0;
console.log(`Registry: ${registry.href}; tag: ${values.tag}; expect published: ${values["expect-published"]}`);
for (const name of names) {
  const manifest = manifests.get(name);
  assert.ok(semver.valid(manifest.version), `Invalid repository version: ${name}`);
  const result = await query(name);
  console.log(`\n${name}: repository ${manifest.version}`);
  if (result.error) {
    console.log(
      `  Registry: ${result.error}; dist-tag: unavailable; repository version published: ${result.notFound ? "no" : "unknown"}`,
    );
    mismatches++;
  } else {
    const tagVersion = result.metadata["dist-tags"]?.[values.tag];
    const published = Object.hasOwn(result.metadata.versions, manifest.version);
    console.log(
      `  Dist-tag ${values.tag}: ${tagVersion ?? "missing"}; repository version published: ${published ? "yes" : "no"}`,
    );
    if (!published || tagVersion !== manifest.version) mismatches++;
  }
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      const internal = manifests.get(dependency);
      const dependencyResult = await query(dependency);
      const label = `${field}: ${dependency}@${range}`;
      if (dependencyResult.error) {
        console.log(`  ${label}: ${dependencyResult.error}`);
        mismatches++;
        continue;
      }
      let matching;
      if (internal) {
        assert.ok(semver.valid(internal.version), `Invalid workspace version: ${dependency}`);
        const workspaceRange = range.startsWith("workspace:") ? range.slice("workspace:".length) : range;
        const requiredRange = ["*", "^", "~"].includes(workspaceRange) ? internal.version : workspaceRange;
        assert.ok(semver.validRange(requiredRange), `Invalid workspace dependency range: ${label}`);
        const acceptsRepository = semver.satisfies(internal.version, requiredRange);
        matching =
          acceptsRepository && Object.hasOwn(dependencyResult.metadata.versions, internal.version)
            ? internal.version
            : null;
      } else {
        assert.ok(semver.validRange(range), `Invalid runtime dependency range: ${label}`);
        matching = semver.maxSatisfying(Object.keys(dependencyResult.metadata.versions), range);
      }
      console.log(
        `  ${label}${internal ? ` (repository ${internal.version})` : ""}: ${matching ? `satisfied by ${matching}` : "no matching published version"}`,
      );
      if (!matching) mismatches++;
    }
  }
}
console.log(`\nChecked ${names.length} packages; ${mismatches} inconsistent package/dependency checks`);
if (values["expect-published"] && mismatches > 0) process.exitCode = 1;
