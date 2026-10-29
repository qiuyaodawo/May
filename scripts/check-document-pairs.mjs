import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { inspectDocument, compareStructure } from "./document-pair.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recordsRoot = resolve(root, "docs/i18n");
const args = process.argv.slice(2);
const write = args[0] === "--write";
const names = [...new Set((write ? args.slice(1) : args).map(name => name.replaceAll("\\", "/")))];
if (names.some(name => name.startsWith("--")) || (write && names.length === 0)) {
  throw new Error("Usage: check-document-pairs.mjs [--write] [relative/document.md ...]; --write requires reviewed document paths");
}
async function files(directory, suffix) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, suffix));
    else if (entry.name.endsWith(suffix)) result.push(path);
  }
  return result;
}
const all = (await files(resolve(root, "docs/en"), ".md")).map(path => relative(resolve(root, "docs/en"), path).split(sep).join("/"));
for (const name of names) if (!all.includes(name)) throw new Error(`Unknown document: ${name}`);
const errors = [];
const pending = [];
for (const name of names.length ? names : all) {
  const [enText, zhText] = await Promise.all(["en", "zh-CN"].map(locale => readFile(resolve(root, "docs", locale, name), "utf8")));
  const en = inspectDocument(enText);
  const zh = inspectDocument(zhText);
  const differences = compareStructure(en, zh);
  errors.push(...differences.map(error => `${name}: ${error}`));
  const record = { version: 1, sections: en.sections.map((section, index) => ({ heading: section.heading, en: section.hash, zh: zh.sections[index]?.hash })) };
  const path = resolve(recordsRoot, name.replace(/\.md$/, ".json"));
  if (write) pending.push({ path, record });
  else {
    let saved;
    try { saved = JSON.parse(await readFile(path, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (saved?.version !== 1 || !Array.isArray(saved.sections)) errors.push(`${name}: missing or invalid confirmation record`);
    else {
      for (let index = 0; index < Math.max(saved.sections.length, record.sections.length); index++) {
        if (!isDeepStrictEqual(saved.sections[index], record.sections[index])) errors.push(`${name}: unconfirmed section ${index + 1} (${record.sections[index]?.heading ?? "removed"})`);
      }
    }
  }
}
if (!write && names.length === 0) {
  const expected = new Set(all.map(name => name.replace(/\.md$/, ".json")));
  for (const path of await files(recordsRoot, ".json")) {
    const name = relative(recordsRoot, path).split(sep).join("/");
    if (!expected.has(name)) errors.push(`Orphan confirmation record: ${name}`);
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
else if (write) {
  for (const { path, record } of pending) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  }
  console.log(`Recorded ${pending.length} bilingual pair confirmations; semantic review is the caller's responsibility.`);
} else console.log(`Checked ${names.length || all.length} bilingual structures and confirmation records.`);
