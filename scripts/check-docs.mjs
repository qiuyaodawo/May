import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(repositoryRoot, "docs");
const chineseRoot = resolve(docsRoot, "zh-CN");

const markdownFiles = await walkMarkdown(docsRoot);
const englishFiles = markdownFiles.filter(
  (file) => file !== chineseRoot && !file.startsWith(`${chineseRoot}${sep}`),
);
const chineseFiles = markdownFiles.filter(
  (file) => file.startsWith(`${chineseRoot}${sep}`),
);

const errors = [];
const expectedChineseFiles = new Set();

for (const englishFile of englishFiles) {
  const documentPath = relative(docsRoot, englishFile);
  const chineseFile = resolve(chineseRoot, documentPath);
  expectedChineseFiles.add(chineseFile);

  const [english, chinese] = await Promise.all([
    readFile(englishFile, "utf8"),
    readDocument(chineseFile, `missing Chinese mirror for ${documentPath}`),
  ]);
  if (chinese === undefined) continue;

  const chineseLink = toMarkdownPath(relative(dirname(englishFile), chineseFile));
  const englishLink = toMarkdownPath(relative(dirname(chineseFile), englishFile));
  if (!english.includes(`[简体中文](${chineseLink})`)) {
    errors.push(`${display(englishFile)}: missing language link to ${chineseLink}`);
  }
  if (!chinese.includes(`[English](${englishLink})`)) {
    errors.push(`${display(chineseFile)}: missing language link to ${englishLink}`);
  }
}

for (const chineseFile of chineseFiles) {
  if (!expectedChineseFiles.has(chineseFile)) {
    errors.push(`${display(chineseFile)}: has no matching English document`);
  }
}

const markdownLink = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
for (const file of markdownFiles) {
  const source = await readFile(file, "utf8");
  if ((source.match(/```/g)?.length ?? 0) % 2 !== 0) {
    errors.push(`${display(file)}: unbalanced fenced code blocks`);
  }

  for (const match of source.matchAll(markdownLink)) {
    const destination = match[1]?.trim();
    if (
      destination === undefined ||
      destination.startsWith("#") ||
      /^(?:https?:|mailto:|file:|codex:)/i.test(destination)
    ) {
      continue;
    }

    const withoutTitle = destination.match(/^<?([^\s>]+)>?(?:\s+.+)?$/)?.[1];
    if (withoutTitle === undefined) continue;
    const filePart = decodeURIComponent(withoutTitle.split("#", 1)[0]);
    if (filePart === "") continue;

    try {
      await stat(resolve(dirname(file), filePart));
    } catch {
      errors.push(`${display(file)}: broken local link ${withoutTitle}`);
    }
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${englishFiles.length} bilingual documentation pairs.`);
}

async function walkMarkdown(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdown(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

async function readDocument(file, missingMessage) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      errors.push(missingMessage);
      return undefined;
    }
    throw error;
  }
}

function toMarkdownPath(path) {
  return path.split(sep).join("/");
}

function display(file) {
  return toMarkdownPath(relative(repositoryRoot, file));
}
