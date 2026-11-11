import { z } from "zod";
import { extname } from "node:path";
import type { Tool } from "@sortedyuan/may/core";
import { createTextChangePreview, type WorkspaceFileGuard } from "@sortedyuan/coding-tools";
import type { LanguageServerManager, SymbolPosition, RenamePreview } from "./types.js";

const positionFields = {
  path: z.string().min(1),
  line: z.number().int().positive(),
  symbol: z.string().min(1).optional(),
  occurrence: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
};
function validPosition(value: {
  symbol?: string | undefined;
  column?: number | undefined;
  occurrence?: number | undefined;
}): boolean {
  return (
    (value.symbol === undefined) !== (value.column === undefined) &&
    (value.occurrence === undefined || value.symbol !== undefined)
  );
}
const position = z
  .object(positionFields)
  .strict()
  .refine(validPosition, "Provide symbol or column; occurrence requires symbol");
const rename = z
  .object({ ...positionFields, newName: z.string().min(1) })
  .strict()
  .refine(validPosition, "Provide symbol or column; occurrence requires symbol");
const file = z.object({ path: z.string().min(1) }).strict();

/** @experimental */
export interface LspToolsOptions {
  readonly guard?: WorkspaceFileGuard;
}

/** @experimental */
export function createLspTools(manager: LanguageServerManager, options: LspToolsOptions = {}): Tool[] {
  function tool<T>(
    name: string,
    description: string,
    schema: z.ZodType<T>,
    execute: Tool<T>["execute"],
    write = false,
  ): Tool {
    return {
      name,
      description,
      workspaceEffect: write ? "write" : "read",
      inputSchema: z.toJSONSchema(schema, { unrepresentable: "any" }),
      parse: (input) => schema.parse(input),
      execute: (input, context) => execute(schema.parse(input), context),
    };
  }
  return [
    tool("lsp_diagnostics", "Get diagnostics for a workspace file.", file, (input, context) =>
      manager.diagnostics(input.path, context.signal),
    ),
    tool(
      "lsp_definition",
      "Find a definition. Positions use one-based line and UTF-16 column, or symbol and occurrence.",
      position,
      async (input, context) => {
        const locations = await manager.definition(input as SymbolPosition, context.signal);
        const extension = extname(input.path).toLowerCase();
        const titles =
          manager
            .status()
            .find((server) =>
              Object.values(server.languages).some((extensions) =>
                extensions.some((value) => value.toLowerCase() === extension),
              ),
            )?.progress ?? [];
        return { locations, ...(titles.length ? { serverBusy: { titles } } : {}) };
      },
    ),
    tool(
      "lsp_references",
      "Find references to a symbol.",
      z
        .object({ ...positionFields, includeDeclaration: z.boolean().optional() })
        .strict()
        .refine(validPosition, "Provide symbol or column"),
      (input, context) =>
        manager.references(input as SymbolPosition, input.includeDeclaration ?? false, context.signal),
    ),
    tool("lsp_hover", "Get hover documentation as text.", position, (input, context) =>
      manager.hover(input as SymbolPosition, context.signal),
    ),
    tool("lsp_document_symbols", "List symbols in a workspace file.", file, (input, context) =>
      manager.documentSymbols(input.path, context.signal),
    ),
    tool(
      "lsp_workspace_symbols",
      "Find workspace symbols using a configured server id as language.",
      z.object({ language: z.string().min(1), query: z.string() }).strict(),
      (input, context) => manager.workspaceSymbols(input.language, input.query, context.signal),
    ),
    tool(
      "lsp_rename",
      "Rename a symbol across workspace files. Applies the approved preview atomically per file, with transaction recovery.",
      rename,
      async (input, context) => {
        const parsed = input as SymbolPosition & { newName: string };
        const plan =
          manager.takeRename(context.toolCallId, parsed) ??
          (await manager.planRename(parsed, parsed.newName, context.signal));
        return manager.executeRename(plan, context.signal, options.guard);
      },
      true,
    ),
  ];
}

/** @experimental */
export async function createRenamePreview(
  manager: LanguageServerManager,
  input: unknown,
  toolCallId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<RenamePreview> {
  const parsed = rename.parse(input) as SymbolPosition & { newName: string };
  const plan = await manager.planRename(parsed, parsed.newName, signal);
  const files = plan.files.map((file) =>
    createTextChangePreview("edit", file.path.relative, file.original, file.updated),
  );
  manager.cacheRename(toolCallId, parsed, plan);
  return { kind: "maybecode.lsp-rename-preview", files };
}
