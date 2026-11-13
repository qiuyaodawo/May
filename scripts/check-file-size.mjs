import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const LIMIT_BYTES = 20_000;
const BASELINE = "scripts/file-size-baseline.json";

const baseline = new Set(JSON.parse(readFileSync(new URL("./file-size-baseline.json", import.meta.url), "utf8")));

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function stagedPaths(filter) {
  return git("diff", "--cached", "--name-only", `--diff-filter=${filter}`, "-z").split("\0").filter(Boolean);
}

const AGENT_DOCUMENT_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "SKILL.md"]);
// Keep in sync with the guides linked from the root AGENTS.md.
const AGENT_GUIDES = new Set(["docs/zh-CN/guides/repository-development.md", "docs/zh-CN/guides/npm-release.md"]);

function isAgentDocument(path) {
  return AGENT_DOCUMENT_NAMES.has(path.split("/").at(-1)) || AGENT_GUIDES.has(path);
}

// Lockfiles, generated reports and records, and documents written for people: agents do not read these whole.
function isExempt(path) {
  return (
    path === "pnpm-lock.yaml" ||
    path === "scripts/api-stability.json" ||
    path === BASELINE ||
    path.startsWith("api/") ||
    path.startsWith("docs/i18n/") ||
    path.endsWith(".schema.json") ||
    (path.endsWith(".md") && !isAgentDocument(path))
  );
}

const failures = [];

for (const path of stagedPaths("ACMR")) {
  if (isExempt(path)) continue;
  const bytes = Number(git("cat-file", "-s", `:${path}`));
  if (bytes > LIMIT_BYTES && !baseline.has(path)) {
    failures.push(
      `${path} is ${bytes} bytes (about ${Math.ceil(bytes / 4)} tokens); the limit is ${LIMIT_BYTES} bytes (5,000 tokens). ` +
        "Divide it into several files by responsibility, then commit again.",
    );
  }
  if (bytes <= LIMIT_BYTES && baseline.has(path)) {
    failures.push(`${path} is now within the limit (${bytes} bytes). Remove it from ${BASELINE}.`);
  }
}

for (const path of stagedPaths("D")) {
  if (baseline.has(path)) failures.push(`${path} is deleted. Remove it from ${BASELINE}.`);
}

if (failures.length > 0) {
  console.error(`File size check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
  process.exit(1);
}
