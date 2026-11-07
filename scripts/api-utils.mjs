import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript-api";
import { repository, runPnpm } from "./release-utils.mjs";

export async function publicEntrypoints() {
  const names = JSON.parse(await readFile(join(repository, "scripts/release-packages.json"), "utf8"));
  const projects = JSON.parse(runPnpm(["list", "--recursive", "--depth", "-1", "--json"]));
  const entries = [];
  for (const name of names) {
    const project = projects.find((item) => item.name === name);
    assert.ok(project, `Missing package ${name}`);
    const manifest = JSON.parse(await readFile(join(project.path, "package.json"), "utf8"));
    for (const [entrypoint, target] of Object.entries(manifest.exports)) {
      const declaration = typeof target === "object" ? target.types : undefined;
      entries.push({
        package: name,
        entrypoint,
        directory: project.path,
        version: manifest.version,
        declaration: declaration ? resolve(project.path, declaration) : undefined,
        source: declaration
          ? resolve(project.path, declaration.replace("./dist/", "./src/").replace(/\.d\.ts$/u, ".ts"))
          : undefined,
        target,
      });
    }
  }
  return entries;
}

export function exportInventory(entries) {
  const roots = [...new Set(entries.flatMap((entry) => (entry.source ? [entry.source] : [])))];
  const program = ts.createProgram(roots, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
  const diagnostics = program.getSyntacticDiagnostics();
  assert.equal(
    diagnostics.length,
    0,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: () => repository,
      getNewLine: () => "\n",
    }),
  );
  const checker = program.getTypeChecker();
  const inventory = [];
  for (const entry of entries) {
    if (!entry.source) continue;
    const source = program.getSourceFile(entry.source);
    assert.ok(source, `Missing source ${entry.source}`);
    const module = checker.getSymbolAtLocation(source);
    assert.ok(module, `Missing module ${entry.source}`);
    for (const exported of checker.getExportsOfModule(module)) {
      const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      const declarations = symbol.getDeclarations() ?? [];
      const tags = symbol.getJsDocTags(checker).map((tag) => tag.name);
      inventory.push({
        package: entry.package,
        entrypoint: entry.entrypoint,
        symbol: exported.name,
        version: entry.version,
        tags,
        declarations: declarations.map((declaration) => ({
          file: declaration.getSourceFile().fileName,
          line: ts.getLineAndCharacterOfPosition(declaration.getSourceFile(), declaration.getStart()).line + 1,
        })),
      });
      if (
        entry.package === "@sortedyuan/may" &&
        ["AgentApplication", "Session", "AgentDefinition", "PluginContext"].includes(exported.name)
      ) {
        const seen = new Set();
        for (const declaration of declarations) {
          if (!ts.isClassDeclaration(declaration) && !ts.isInterfaceDeclaration(declaration)) continue;
          for (const member of declaration.members) {
            if (!member.name || ts.isPrivateIdentifier(member.name)) continue;
            if (ts.getCombinedModifierFlags(member) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
            const name = member.name.getText();
            if (seen.has(name)) continue;
            seen.add(name);
            const memberSymbol = checker.getSymbolAtLocation(member.name);
            assert.ok(memberSymbol, `Missing member symbol: ${exported.name}.${name}`);
            inventory.push({
              package: entry.package,
              entrypoint: entry.entrypoint,
              symbol: `${exported.name}.${name}`,
              version: entry.version,
              tags: memberSymbol.getJsDocTags(checker).map((tag) => tag.name),
              declarations: (memberSymbol.getDeclarations() ?? []).map((item) => ({
                file: item.getSourceFile().fileName,
                line: ts.getLineAndCharacterOfPosition(item.getSourceFile(), item.getStart()).line + 1,
              })),
            });
          }
        }
      }
    }
  }
  return inventory;
}
