import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Extractor, ExtractorConfig } from "@microsoft/api-extractor";
import semver from "semver";
import { exportInventory, publicEntrypoints } from "./api-utils.mjs";

const { values } = parseArgs({ options: { update: { type: "boolean" }, inventory: { type: "boolean" } } });
assert.ok(!(values.update && values.inventory), "Choose --update or --inventory");
const entries = await publicEntrypoints();
const inventory = exportInventory(entries);
if (values.inventory) {
  await writeFile("review/impl-batch-c/api-inventory.json", JSON.stringify(inventory, null, 2) + "\n");
  console.log(`${entries.length} entrypoints; ${inventory.length} exported symbols`);
  for (const [name, symbols] of Object.entries(Object.groupBy(inventory, (item) => item.package))) {
    console.log(`${name}: ${symbols.length}`);
  }
} else {
  const update = values.update === true;
  const manifest = JSON.parse(await readFile("scripts/api-stability.json", "utf8"));
  const key = (item) => JSON.stringify([item.package, item.entrypoint, item.symbol]);
  const expected = new Map();
  for (const item of manifest) {
    assert.ok(!expected.has(key(item)), `Duplicate stability entry: ${key(item)}`);
    assert.ok(["stable", "experimental"].includes(item.stability), `Invalid stability: ${key(item)}`);
    assert.ok(typeof item.since === "string" && semver.valid(item.since), `Invalid since: ${key(item)}`);
    assert.ok(
      item.replacement === undefined || (typeof item.replacement === "string" && item.replacement.length),
      `Invalid replacement: ${key(item)}`,
    );
    assert.ok(typeof item.docs === "string" && existsSync(item.docs), `Missing documentation: ${key(item)}`);
    expected.set(key(item), item);
  }
  for (const item of inventory) {
    const record = expected.get(key(item));
    assert.ok(record, `Missing stability entry: ${key(item)}`);
    const tag = record.stability === "stable" ? "public" : "experimental";
    assert.ok(item.tags.includes(tag), `Missing @${tag} declaration: ${key(item)}`);
    assert.ok(
      !item.tags.includes(tag === "public" ? "experimental" : "public"),
      `Conflicting declaration tags: ${key(item)}`,
    );
    expected.delete(key(item));
  }
  assert.equal(expected.size, 0, `Extra stability entries: ${[...expected.keys()].join(", ")}`);
  let reports = 0;
  const changed = [];
  const reportPaths = new Set();
  for (const entry of entries) {
    const packageName = entry.package.split("/")[1];
    const reportName = entry.entrypoint === "." ? "index" : entry.entrypoint.slice(2).replaceAll("/", "__");
    const report = entry.declaration
      ? await declarationReport(entry, packageName, reportName)
      : await resourceReport(entry);
    const destination = join("api", packageName, `${reportName}.api.md`);
    assert.ok(!reportPaths.has(resolve(destination)), `Duplicate report path: ${destination}`);
    reportPaths.add(resolve(destination));
    if (update) {
      await mkdir(join("api", packageName), { recursive: true });
      await writeFile(destination, report);
    } else if (!existsSync(destination) || (await readFile(destination, "utf8")).replaceAll("\r\n", "\n") !== report) {
      changed.push(destination);
    }
    reports++;
  }
  for (const item of await readdir("api", { recursive: true, withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith(".api.md")) continue;
    const path = join(item.parentPath, item.name);
    assert.ok(reportPaths.has(resolve(path)), `Orphan API report: ${path}`);
  }
  assert.equal(changed.length, 0, `API reports differ; run pnpm api:update:\n${changed.join("\n")}`);
  console.log(`Verified ${inventory.length} stability entries and ${reports} API reports`);
}

async function resourceReport(entry) {
  assert.equal(typeof entry.target, "string", `Missing declaration target: ${entry.package} ${entry.entrypoint}`);
  const content = await readFile(resolve(entry.directory, entry.target), "utf8");
  const digest = createHash("sha256").update(content.replaceAll("\r\n", "\n")).digest("hex");
  return `## Public resource: ${entry.package}${entry.entrypoint.slice(1)}\n\nTarget: \`${entry.target}\`\n\nSHA-256 (LF): \`${digest}\`\n\nThis entrypoint has no TypeScript declarations.\n`;
}

async function declarationReport(entry, packageName, reportName) {
  const generated = resolve("review/impl-batch-c/api-generated", packageName);
  const temporary = resolve("review/impl-batch-c/api-temporary", packageName);
  await mkdir(generated, { recursive: true });
  const config = ExtractorConfig.prepare({
    configObject: {
      projectFolder: entry.directory,
      mainEntryPointFilePath: entry.declaration,
      compiler: {
        overrideTsconfig: {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            skipLibCheck: true,
            types: ["node"],
            typeRoots: [resolve("node_modules/@types")],
          },
          files: [entry.declaration],
        },
      },
      apiReport: { enabled: true, reportFolder: generated, reportTempFolder: temporary, reportFileName: reportName },
      docModel: { enabled: false },
      dtsRollup: { enabled: false },
      tsdocMetadata: { enabled: false },
      newlineKind: "lf",
    },
    configObjectFullPath: undefined,
    packageJsonFullPath: join(entry.directory, "package.json"),
  });
  const result = Extractor.invoke(config, { localBuild: true });
  assert.ok(result.succeeded, `API Extractor failed: ${entry.package} ${entry.entrypoint}`);
  return readFile(join(generated, `${reportName}.api.md`), "utf8");
}
