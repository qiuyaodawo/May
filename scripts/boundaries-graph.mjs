import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript-api";

export const SKIP = new Set(["node_modules", "dist", ".git", ".test-output"]);
const SRC_EXT = /\.(ts|tsx|mts|js|mjs)$/;
const DECL_EXT = /\.d\.(ts|mts|cts)$/;

function resolveDistTarget(dir, relStr) {
  const clean = relStr.replace(/^\.\//, "");
  if (clean.startsWith("dist/")) {
    const stem = `src/${clean.slice(5).replace(/\.m?js$/, "")}`;
    for (const ext of [".ts", ".tsx", ".mts"]) {
      const cand = path.posix.join(dir, stem + ext);
      if (existsSync(cand) && statSync(cand).isFile()) return cand;
    }
  }
  const direct = path.posix.join(dir, clean);
  return existsSync(direct) && statSync(direct).isFile() ? direct : null;
}

function extractImportString(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    return extractImportString(value.import ?? value.default ?? Object.values(value)[0]);
  }
  return null;
}

export function collectExports(dir, field) {
  const targets = new Set();
  const bySubpath = new Map();
  if (typeof field === "string") {
    const resolved = resolveDistTarget(dir, field);
    if (resolved) {
      targets.add(resolved);
      bySubpath.set(".", resolved);
    }
  } else if (field && typeof field === "object") {
    for (const [sub, value] of Object.entries(field)) {
      const imp = extractImportString(value);
      const resolved = imp ? resolveDistTarget(dir, imp) : null;
      if (resolved) {
        targets.add(resolved);
        bySubpath.set(sub, resolved);
      }
    }
  }
  return { targets, bySubpath };
}

export function hasExport(field, sub) {
  if (field === undefined || typeof field === "string") return sub === ".";
  if (!field || typeof field !== "object") return false;
  if (Object.hasOwn(field, sub)) return true;
  return Object.keys(field).some((k) => {
    const i = k.indexOf("*");
    return i !== -1 && sub.startsWith(k.slice(0, i)) && sub.endsWith(k.slice(i + 1)) && sub.length >= k.length - 1;
  });
}

export function walkFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.posix.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (SRC_EXT.test(e.name) && !DECL_EXT.test(e.name)) out.push(p);
  }
  return out;
}

export function parseRefsText(file, text, kind) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const refs = [];
  const push = (spec, node) => refs.push({ spec, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });

  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      push(n.moduleSpecifier.text, n);
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      push(n.moduleSpecifier.text, n);
    } else if (
      ts.isImportEqualsDeclaration(n) &&
      ts.isExternalModuleReference(n.moduleReference) &&
      ts.isStringLiteral(n.moduleReference.expression)
    ) {
      push(n.moduleReference.expression.text, n);
    } else if (ts.isCallExpression(n) && n.arguments.length >= 1) {
      const arg = n.arguments[0];
      if (
        (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(n.expression) && n.expression.text === "require"))
      ) {
        push(arg.text, n);
      }
    } else if (ts.isImportTypeNode(n) && ts.isLiteralTypeNode(n.argument) && ts.isStringLiteral(n.argument.literal)) {
      push(n.argument.literal.text, n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return refs;
}

export function parseRefs(file) {
  const kind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".ts") || file.endsWith(".mts")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.JS;
  return parseRefsText(file, readFileSync(file, "utf8"), kind);
}

export function resolveRel(from, spec) {
  const norm = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  const cands = [norm];
  if (norm.endsWith(".js")) cands.push(`${norm.slice(0, -3)}.ts`, `${norm.slice(0, -3)}.tsx`);
  else if (norm.endsWith(".mjs")) cands.push(`${norm.slice(0, -4)}.mts`);
  else if (!path.posix.extname(norm)) {
    for (const s of [".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"])
      cands.push(norm + s);
  }
  return cands.find((c) => existsSync(c) && statSync(c).isFile()) ?? norm;
}

export function resolveSelfPackageSpec(pkg, spec) {
  if (!spec.startsWith("@sortedyuan/")) return null;
  const parts = spec.split("/");
  if (`${parts[0]}/${parts[1]}` !== pkg.name) return null;
  const sub = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
  return pkg.exportBySubpath.get(sub) ?? null;
}

export const addEdge = (g, a, b) => (g.get(a) ?? g.set(a, new Set()).get(a)).add(b);

export function findSccs(graph) {
  let idx = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const sccs = [];
  const nodes = new Set(graph.keys());
  for (const tsSet of graph.values()) for (const t of tsSet) nodes.add(t);

  const dfs = (v) => {
    indices.set(v, idx);
    low.set(v, idx++);
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!indices.has(w)) {
        dfs(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), indices.get(w)));
      }
    }
    if (low.get(v) === indices.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || (comp.length === 1 && graph.get(v)?.has(v))) sccs.push(comp.sort());
    }
  };
  for (const n of [...nodes].sort()) if (!indices.has(n)) dfs(n);
  return sccs;
}

export function cycleSample(scc, graph) {
  const members = new Set(scc);
  const start = scc[0];
  const queue = [[start]];
  const seen = new Set();
  while (queue.length) {
    const chain = queue.shift();
    for (const next of graph.get(chain.at(-1)) ?? []) {
      if (!members.has(next)) continue;
      if (next === start) return [...chain, start];
      if (!seen.has(next)) {
        seen.add(next);
        queue.push([...chain, next]);
      }
    }
  }
  return [...scc, start];
}

/** Build exact emitted-JS runtime graph for files in candidate SCCs via TypeScript transpile. */
export function buildRuntimeGraph(candidateFiles, fileToPkg) {
  const runtimeGraph = new Map();
  for (const file of candidateFiles) {
    const pkg = fileToPkg.get(file);
    if (!pkg) continue;
    const emitted = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.Preserve,
        verbatimModuleSyntax: false,
      },
    }).outputText;
    for (const { spec } of parseRefsText(file, emitted, ts.ScriptKind.JS)) {
      let resolved = null;
      if (spec.startsWith(".")) {
        const cand = resolveRel(file, spec);
        if (cand.startsWith(`${pkg.dir}/src/`)) resolved = cand;
      } else if (spec.startsWith("@sortedyuan/")) {
        resolved = resolveSelfPackageSpec(pkg, spec);
      }
      if (resolved && candidateFiles.has(resolved)) {
        addEdge(runtimeGraph, file, resolved);
      }
    }
  }
  return runtimeGraph;
}
