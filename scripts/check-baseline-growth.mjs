import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function verifyCommitRef(ref) {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Invalid git --base ref "${ref}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJsonAtRef(ref, relPath) {
  try {
    execFileSync("git", ["cat-file", "-e", `${ref}:${relPath}`], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {
    return undefined;
  }
  const raw = execFileSync("git", ["show", `${ref}:${relPath}`], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw);
}

function expandCycleEdges(raw) {
  const edges = new Set();
  if (Array.isArray(raw)) {
    for (const item of raw) edges.add(item);
    return edges;
  }
  if (raw && typeof raw === "object") {
    for (const [from, targets] of Object.entries(raw)) {
      if (!Array.isArray(targets)) continue;
      for (const to of targets) edges.add(`${from} -> ${to}`);
    }
  }
  return edges;
}

export function validateBoundariesBaselineSchema(boundaries) {
  const errors = [];
  if (!boundaries || typeof boundaries !== "object" || Array.isArray(boundaries)) {
    return ["[invalid-baseline] scripts/boundaries-baseline.json must be a JSON object."];
  }
  if (!Array.isArray(boundaries.relativeEscapes)) {
    errors.push('[invalid-baseline] scripts/boundaries-baseline.json must define array "relativeEscapes".');
  } else {
    const seen = new Set();
    for (const item of boundaries.relativeEscapes) {
      if (typeof item !== "string" || !item.includes(" -> ")) {
        errors.push(
          `[invalid-baseline] scripts/boundaries-baseline.json invalid relativeEscapes entry: ${JSON.stringify(item)}.`,
        );
        continue;
      }
      if (seen.has(item)) {
        errors.push(
          `[invalid-baseline] Duplicate relativeEscapes entry in scripts/boundaries-baseline.json: "${item}".`,
        );
      }
      if ((item.split(" -> ")[0] ?? "").includes("/src/")) {
        errors.push(`[invalid-baseline] scripts/boundaries-baseline.json cannot baseline src/ escape "${item}".`);
      }
      seen.add(item);
    }
  }
  const edges = boundaries.typeOnlyCycleEdges;
  if (!edges || typeof edges !== "object" || Array.isArray(edges)) {
    errors.push(
      '[invalid-baseline] scripts/boundaries-baseline.json must define object "typeOnlyCycleEdges" mapping source -> target[].',
    );
  } else {
    for (const [from, targets] of Object.entries(edges)) {
      if (!Array.isArray(targets)) {
        errors.push(
          `[invalid-baseline] scripts/boundaries-baseline.json typeOnlyCycleEdges["${from}"] must be an array.`,
        );
        continue;
      }
      const seenTargets = new Set();
      for (const to of targets) {
        if (typeof to !== "string" || to.length === 0) {
          errors.push(
            `[invalid-baseline] scripts/boundaries-baseline.json invalid target under "${from}": ${JSON.stringify(to)}.`,
          );
          continue;
        }
        if (seenTargets.has(to)) {
          errors.push(
            `[invalid-baseline] Duplicate typeOnlyCycleEdges entry in scripts/boundaries-baseline.json: "${from} -> ${to}".`,
          );
        }
        seenTargets.add(to);
      }
    }
  }
  return errors;
}

export function compareBoundariesBaseline(base, head) {
  const errors = [];
  if (!base) return errors;
  const baseEscapes = new Set(base.relativeEscapes ?? []);
  for (const item of head.relativeEscapes ?? []) {
    if (!baseEscapes.has(item)) {
      errors.push(
        `[baseline-growth] scripts/boundaries-baseline.json (relativeEscapes) added new entry "${item}". Baselines may only shrink.`,
      );
    }
  }
  const baseEdges = expandCycleEdges(base.typeOnlyCycleEdges);
  for (const edge of expandCycleEdges(head.typeOnlyCycleEdges)) {
    if (!baseEdges.has(edge)) {
      errors.push(
        `[baseline-growth] scripts/boundaries-baseline.json (typeOnlyCycleEdges) added new edge "${edge}". Baselines may only shrink.`,
      );
    }
  }
  return errors;
}

export function compareBanHacksBaseline(base, head) {
  const errors = [];
  if (!base) return errors;
  for (const key of ["asUnknownAs", "testPromiseSetTimeout"]) {
    const baseMap = base[key] ?? {};
    const headMap = head[key] ?? {};
    for (const [file, headList] of Object.entries(headMap)) {
      const baseCounts = new Map();
      for (const sig of baseMap[file] ?? []) baseCounts.set(sig, (baseCounts.get(sig) ?? 0) + 1);
      const headCounts = new Map();
      for (const sig of headList) headCounts.set(sig, (headCounts.get(sig) ?? 0) + 1);
      for (const [sig, count] of headCounts.entries()) {
        const prev = baseCounts.get(sig) ?? 0;
        if (count > prev) {
          errors.push(
            `[baseline-growth] scripts/eslint-ban-hacks-baseline.json (${key}["${file}"]) grew "${sig}" (${prev} -> ${count}). Baselines may only shrink.`,
          );
        }
      }
    }
  }
  const baseNna = base.nonNullAssertion ?? {};
  const headNna = head.nonNullAssertion ?? {};
  for (const [file, count] of Object.entries(headNna)) {
    const prev = baseNna[file] ?? 0;
    if (count > prev) {
      errors.push(
        `[baseline-growth] scripts/eslint-ban-hacks-baseline.json (nonNullAssertion["${file}"]) increased (${prev} -> ${count}). Baselines may only shrink.`,
      );
    }
  }
  return errors;
}

export function validateExistingBaselineFiles(banHacksBaseline) {
  const errors = [];
  if (!banHacksBaseline || typeof banHacksBaseline !== "object" || Array.isArray(banHacksBaseline)) {
    return ["[invalid-baseline] scripts/eslint-ban-hacks-baseline.json must be a JSON object."];
  }
  for (const key of ["asUnknownAs", "testPromiseSetTimeout"]) {
    const section = banHacksBaseline[key];
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      errors.push(`[invalid-baseline] scripts/eslint-ban-hacks-baseline.json must define object "${key}".`);
      continue;
    }
    for (const [file, snippets] of Object.entries(section)) {
      if (!existsSync(path.join(ROOT, file))) {
        errors.push(
          `[stale-baseline] scripts/eslint-ban-hacks-baseline.json (${key}) references deleted file "${file}". Remove it.`,
        );
      }
      if (!Array.isArray(snippets) || snippets.some((s) => typeof s !== "string" || s.length === 0)) {
        errors.push(
          `[invalid-baseline] scripts/eslint-ban-hacks-baseline.json (${key}["${file}"]) must be a non-empty string array.`,
        );
      }
    }
  }
  const nna = banHacksBaseline.nonNullAssertion;
  if (!nna || typeof nna !== "object" || Array.isArray(nna)) {
    errors.push('[invalid-baseline] scripts/eslint-ban-hacks-baseline.json must define object "nonNullAssertion".');
  } else {
    for (const [file, count] of Object.entries(nna)) {
      if (!existsSync(path.join(ROOT, file))) {
        errors.push(
          `[stale-baseline] scripts/eslint-ban-hacks-baseline.json (nonNullAssertion) references deleted file "${file}". Remove it.`,
        );
      }
      if (!Number.isSafeInteger(count) || count < 1) {
        errors.push(
          `[invalid-baseline] scripts/eslint-ban-hacks-baseline.json (nonNullAssertion["${file}"]) must be a positive safe integer.`,
        );
      }
    }
  }
  return errors;
}

if (
  import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("check-baseline-growth.mjs")
) {
  const args = process.argv.slice(2);
  const baseIdx = args.indexOf("--base");
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : undefined;
  if (baseIdx >= 0 && !baseRef) {
    console.error("Missing value for --base");
    process.exit(1);
  }

  const headBoundaries = JSON.parse(readFileSync(path.join(ROOT, "scripts/boundaries-baseline.json"), "utf8"));
  const headBanHacks = JSON.parse(readFileSync(path.join(ROOT, "scripts/eslint-ban-hacks-baseline.json"), "utf8"));
  const errors = [...validateBoundariesBaselineSchema(headBoundaries), ...validateExistingBaselineFiles(headBanHacks)];

  if (baseRef) {
    verifyCommitRef(baseRef);
    const baseBoundaries = readJsonAtRef(baseRef, "scripts/boundaries-baseline.json");
    const baseBanHacks = readJsonAtRef(baseRef, "scripts/eslint-ban-hacks-baseline.json");
    errors.push(...compareBoundariesBaseline(baseBoundaries, headBoundaries));
    errors.push(...compareBanHacksBaseline(baseBanHacks, headBanHacks));
  }

  if (errors.length > 0) {
    console.error(`Baseline integrity check failed (${errors.length} issue(s)):\n`);
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }
  console.log(`Baseline integrity check passed${baseRef ? ` against ${baseRef}` : ""}.`);
}
