import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  addEdge,
  buildRuntimeGraph,
  collectExports,
  cycleSample,
  findSccs,
  hasExport,
  parseRefs,
  resolveRel,
  walkFiles,
} from "./boundaries-graph.mjs";

const BASELINE = "scripts/boundaries-baseline.json";
const ROOTS = ["packages", "packages/tools", "packages/ui", "apps", "examples"];
const RANK = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 };

const LAYERS = new Map([
  ["@sortedyuan/may", "L0"],
  ["@sortedyuan/media", "L1"],
  ["@sortedyuan/observability", "L1"],
  ["@sortedyuan/providers", "L1"],
  ["@sortedyuan/scheduler", "L1"],
  ["@sortedyuan/coding-tools", "L1"],
  ["@sortedyuan/gateway", "L1"],
  ["@sortedyuan/mcp", "L1"],
  ["@sortedyuan/lsp-tools", "L2"],
  ["@sortedyuan/coordination", "L2"],
  ["@sortedyuan/eval", "L2"],
  ["@sortedyuan/ui-client", "L2"],
  ["@sortedyuan/tui", "L2"],
  ["@sortedyuan/web-ui", "L2"],
  ["@sortedyuan/test-support", "test-support"],
]);

const SAME_LAYER_ALLOW = new Map([
  ["@sortedyuan/gateway", new Set(["@sortedyuan/media"])],
  ["@sortedyuan/mcp", new Set(["@sortedyuan/observability"])],
  ["@sortedyuan/eval", new Set(["@sortedyuan/coordination"])],
  ["@sortedyuan/web-ui", new Set(["@sortedyuan/ui-client"])],
]);

const COMPAT_PROVIDERS = new Set(["deepseek", "kimi", "zhipu"]);

const pkgLayer = (name, dir) =>
  LAYERS.get(name) ?? (dir.startsWith("apps/") ? "L3" : dir.startsWith("examples/") ? "L4" : null);

function allowedSummary(pkg) {
  if (pkg.layer === "L0" || pkg.layer === "test-support") return `none (${pkg.layer} allows 0 workspace deps)`;
  const same = [...(SAME_LAYER_ALLOW.get(pkg.name) ?? [])];
  const base = { L1: "L0 (@sortedyuan/may)", L2: "L0–L1", L3: "L0–L2 (no app->app)", L4: "L0–L3 by package name" }[
    pkg.layer
  ];
  return same.length ? `${base} + ${same.join(", ")}` : base;
}

function allowedLayer(from, to) {
  if (from.name === to.name) return true;
  if (!from.layer || !to.layer || from.layer === "test-support" || to.layer === "test-support") return false;
  return (
    RANK[to.layer] < RANK[from.layer] ||
    (RANK[to.layer] === RANK[from.layer] && (SAME_LAYER_ALLOW.get(from.name)?.has(to.name) ?? false))
  );
}

function discoverPackages() {
  const packages = [];
  const byName = new Map();
  for (const root of ROOTS) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.posix.join(root, e.name);
      const manifest = path.join(dir, "package.json");
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8"));
      const { targets, bySubpath } = collectExports(dir, json.exports);
      const pkg = {
        dir,
        name: json.name,
        json,
        layer: pkgLayer(json.name, dir),
        deps: new Set([
          ...Object.keys(json.dependencies ?? {}),
          ...Object.keys(json.peerDependencies ?? {}),
          ...Object.keys(json.optionalDependencies ?? {}),
        ]),
        exportTargets: targets,
        exportBySubpath: bySubpath,
      };
      packages.push(pkg);
      byName.set(pkg.name, pkg);
    }
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  return { packages, byName };
}

function loadBaseline(errors) {
  const raw = JSON.parse(readFileSync(BASELINE, "utf8"));
  const relativeEscapes = new Set();
  if (!Array.isArray(raw.relativeEscapes)) {
    errors.push(`[invalid-baseline] ${BASELINE} must define array "relativeEscapes".`);
  } else {
    for (const item of raw.relativeEscapes) {
      if (relativeEscapes.has(item)) {
        errors.push(`[invalid-baseline] Duplicate relativeEscapes entry in ${BASELINE}: "${item}".`);
      }
      if ((item.split(" -> ")[0] ?? "").includes("/src/")) {
        errors.push(`[invalid-baseline] ${BASELINE} cannot baseline src/ escape "${item}".`);
      }
      relativeEscapes.add(item);
    }
  }
  const typeOnlyCycleEdges = new Set();
  if (!raw.typeOnlyCycleEdges || typeof raw.typeOnlyCycleEdges !== "object" || Array.isArray(raw.typeOnlyCycleEdges)) {
    errors.push(`[invalid-baseline] ${BASELINE} must define object "typeOnlyCycleEdges" mapping source -> target[].`);
  } else {
    for (const [from, targets] of Object.entries(raw.typeOnlyCycleEdges)) {
      if (!Array.isArray(targets)) {
        errors.push(`[invalid-baseline] ${BASELINE} typeOnlyCycleEdges["${from}"] must be an array.`);
        continue;
      }
      for (const to of targets) {
        const edge = `${from} -> ${to}`;
        if (typeOnlyCycleEdges.has(edge)) {
          errors.push(`[invalid-baseline] Duplicate typeOnlyCycleEdges entry in ${BASELINE}: "${edge}".`);
        }
        typeOnlyCycleEdges.add(edge);
      }
    }
  }
  return { relativeEscapes, typeOnlyCycleEdges };
}

function checkIntraSrcTarget(pkg, file, resolved, spec, line, allGraph, errors) {
  addEdge(allGraph, file, resolved);
  const fromDirs = file
    .slice(pkg.dir.length + 5)
    .split("/")
    .slice(0, -1);
  const toDirs = resolved
    .slice(pkg.dir.length + 5)
    .split("/")
    .slice(0, -1);
  const [fromTop = "", toTop = ""] = [fromDirs[0], toDirs[0]];

  if (pkg.name === "@sortedyuan/providers" && fromTop && toTop && fromTop !== toTop && toTop !== "internal") {
    const okCompat = COMPAT_PROVIDERS.has(fromTop) && resolved === "packages/providers/src/openai-compatible/index.ts";
    if (!okCompat) {
      const fix =
        COMPAT_PROVIDERS.has(fromTop) && toTop === "openai-compatible"
          ? `Import "../openai-compatible/index.js" or top-level "../http.js" instead.`
          : `Lateral provider imports ("${fromTop}/" -> "${toTop}/") are forbidden; move shared helpers to top-level "packages/providers/src/" (e.g. "../http.js").`;
      errors.push(`[provider-lateral-import] ${file}:${line} imports "${spec}". ${fix}`);
      return;
    }
  }

  let common = 0;
  while (common < fromDirs.length && common < toDirs.length && fromDirs[common] === toDirs[common]) common++;
  for (let d = common + 1; d <= toDirs.length; d++) {
    if (toDirs[d - 1] === "internal") break;
    const sub = path.posix.join(pkg.dir, "src", ...toDirs.slice(0, d));
    const facade = existsSync(`${sub}/index.ts`)
      ? `${sub}/index.ts`
      : existsSync(`${sub}/index.tsx`)
        ? `${sub}/index.tsx`
        : null;
    if (!facade) continue;
    if (resolved !== facade && !pkg.exportTargets.has(resolved)) {
      const relF = path.posix.relative(path.posix.dirname(file), facade).replace(/\.tsx?$/, ".js");
      const legal = relF.startsWith(".") ? relF : `./${relF}`;
      errors.push(
        `[subdir-internal-bypass] ${file}:${line} imports "${spec}", bypassing "${facade}". Import "${legal}" (or an explicit export in ${pkg.dir}/package.json#exports), or move shared private helpers into "${pkg.dir}/src/internal/".`,
      );
    }
    break;
  }
}

export function classifyPackageFile(pkg, rel) {
  const inSrc = rel.startsWith("src/");
  const inTest = rel.startsWith("test/");
  const inScripts = rel.startsWith("scripts/");
  const isProd = inSrc || (pkg.layer === "L4" && !inTest && !inScripts) || pkg.layer === "test-support";
  const allowTestSupport = inTest || inScripts || pkg.name === "@sortedyuan/test-support";
  return { inSrc, inTest, inScripts, isProd, allowTestSupport };
}

export function analyzeBoundaries() {
  const errors = [];
  const baseline = loadBaseline(errors);
  const { packages, byName } = discoverPackages();
  const seenEscapes = new Set();
  const allGraph = new Map();
  const fileToPkg = new Map();

  for (const pkg of packages) {
    if (!pkg.layer) {
      errors.push(`[layer-matrix] "${pkg.name}" (${pkg.dir}) has no layer; assign it in scripts/check-boundaries.mjs.`);
      continue;
    }

    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const dep of Object.keys(pkg.json[field] ?? {})) {
        if (!dep.startsWith("@sortedyuan/")) continue;
        const target = byName.get(dep);
        if (!target) {
          errors.push(`[unknown-workspace-package] ${pkg.dir}/package.json (${field}) references unknown "${dep}".`);
        } else if (dep === "@sortedyuan/test-support") {
          errors.push(
            `[test-support-scope] ${pkg.dir}/package.json lists "@sortedyuan/test-support" in "${field}". Move to devDependencies (test/ and scripts/ only).`,
          );
        } else if (!allowedLayer(pkg, target)) {
          errors.push(
            `[layer-matrix] ${pkg.dir}/package.json (${field}): ${pkg.layer} "${pkg.name}" cannot depend on ${target.layer} "${dep}". Allowed: ${allowedSummary(pkg)}.`,
          );
        }
      }
    }

    for (const file of walkFiles(pkg.dir).sort()) {
      const rel = file.slice(pkg.dir.length + 1);
      const { inSrc, isProd, allowTestSupport } = classifyPackageFile(pkg, rel);
      if (inSrc) fileToPkg.set(file, pkg);

      for (const { spec, line } of parseRefs(file)) {
        if (spec.startsWith("@sortedyuan/")) {
          const parts = spec.split("/");
          const targetName = `${parts[0]}/${parts[1]}`;
          const sub = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
          const target = byName.get(targetName);

          if (targetName === "@sortedyuan/test-support") {
            if (!allowTestSupport) {
              errors.push(
                `[test-support-scope] ${file}:${line} imports "${spec}". "@sortedyuan/test-support" is allowed only in test/ and scripts/.`,
              );
            }
          } else if (isProd) {
            if (!target) {
              errors.push(`[unknown-workspace-package] ${file}:${line} imports unknown workspace "${spec}".`);
              continue;
            }
            if (!allowedLayer(pkg, target)) {
              errors.push(
                `[layer-matrix] ${file}:${line}: ${pkg.layer} "${pkg.name}" cannot import ${target.layer} "${spec}". Allowed: ${allowedSummary(pkg)}.`,
              );
            } else if (targetName !== pkg.name && !pkg.deps.has(targetName)) {
              errors.push(
                `[undeclared-dep] ${file}:${line} imports "${spec}", undeclared in ${pkg.dir}/package.json. Add "${targetName}": "workspace:*" to dependencies and sync pnpm-lock.yaml.`,
              );
            }
          }

          if (target && !hasExport(target.json.exports, sub)) {
            const keys =
              target.json.exports && typeof target.json.exports === "object" ? Object.keys(target.json.exports) : ["."];
            const legal = keys.map((k) => (k === "." ? targetName : `${targetName}/${k.slice(2)}`)).join(", ");
            errors.push(
              `[unexported-subpath] ${file}:${line} imports unexported "${spec}". Use a public export from ${target.dir}/package.json#exports: ${legal}.`,
            );
          }

          if (inSrc && target === pkg) {
            const selfResolved = pkg.exportBySubpath.get(sub);
            if (selfResolved && selfResolved.startsWith(`${pkg.dir}/src/`)) {
              checkIntraSrcTarget(pkg, file, selfResolved, spec, line, allGraph, errors);
            }
          }
          continue;
        }

        if (!spec.startsWith(".")) continue;
        const resolved = resolveRel(file, spec);
        if (resolved !== pkg.dir && !resolved.startsWith(`${pkg.dir}/`)) {
          const key = `${file} -> ${spec}`;
          const owner = packages
            .filter((p) => resolved === p.dir || resolved.startsWith(`${p.dir}/`))
            .sort((a, b) => b.dir.length - a.dir.length)[0];
          const hint = owner
            ? `Import via "${owner.name}" (or a public subpath in ${owner.dir}/package.json#exports).`
            : `Move shared helpers to "@sortedyuan/test-support" or import via workspace package name.`;
          if (inSrc || !baseline.relativeEscapes.has(key)) {
            errors.push(
              `[relative-escape] ${file}:${line} imports "${spec}" escaping "${pkg.dir}" to "${resolved}". ${hint}`,
            );
          }
          if (!inSrc) seenEscapes.add(key);
          continue;
        }

        if (!inSrc || !resolved.startsWith(`${pkg.dir}/src/`)) continue;
        checkIntraSrcTarget(pkg, file, resolved, spec, line, allGraph, errors);
      }
    }
  }

  const allSccs = findSccs(allGraph);
  const candidateFiles = new Set(allSccs.flat());
  const runtimeGraph = buildRuntimeGraph(candidateFiles, fileToPkg);

  const runtimeCycleEdges = new Set();
  for (const scc of findSccs(runtimeGraph)) {
    const members = new Set(scc);
    for (const from of scc) {
      for (const to of runtimeGraph.get(from) ?? []) {
        if (members.has(to)) runtimeCycleEdges.add(`${from} -> ${to}`);
      }
    }
    errors.push(
      `[runtime-value-cycle] Runtime value cycle (${scc.length} files): ${cycleSample(scc, runtimeGraph).join(" -> ")}. Convert type-only refs to "import type", extract a leaf module, or move factory/wiring into a separate file.`,
    );
  }

  const seenCycleEdges = new Set();
  for (const scc of allSccs) {
    const members = new Set(scc);
    for (const from of scc) {
      for (const to of [...(allGraph.get(from) ?? [])].sort()) {
        if (!members.has(to)) continue;
        const edge = `${from} -> ${to}`;
        if (runtimeCycleEdges.has(edge)) continue;
        seenCycleEdges.add(edge);
        if (!baseline.typeOnlyCycleEdges.has(edge)) {
          errors.push(
            `[type-only-cycle-edge] New cyclic dependency edge "${edge}". Extract shared types into a lower leaf module.`,
          );
        }
      }
    }
  }

  for (const [kind, baseSet, seenSet] of [
    ["relativeEscapes", baseline.relativeEscapes, seenEscapes],
    ["typeOnlyCycleEdges", baseline.typeOnlyCycleEdges, seenCycleEdges],
  ]) {
    for (const item of baseSet) {
      if (!seenSet.has(item)) {
        errors.push(`[stale-baseline] ${BASELINE} (${kind}) contains resolved entry "${item}". Remove it.`);
      }
    }
  }

  return { packages, errors, seenEscapes, seenCycleEdges };
}

if (
  import.meta.url === `file:///${process.argv[1]?.replaceAll("\\", "/")}` ||
  process.argv[1]?.endsWith("check-boundaries.mjs")
) {
  const { packages, errors, seenEscapes, seenCycleEdges } = analyzeBoundaries();
  if (errors.length) {
    console.error(`Boundary check failed (${errors.length} violation(s)):\n`);
    for (const err of errors) console.error(`- ${err}`);
    process.exit(1);
  }
  console.log(
    `Boundary check passed (${packages.length} packages, 0 runtime value cycles, ` +
      `${seenEscapes.size} baselined relative escapes, ${seenCycleEdges.size} baselined type-only cycle edges).`,
  );
}
