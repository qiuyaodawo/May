import { defineTool, type Tool } from "@sortedyuan/may/core";
import { z } from "zod";
import { runSearch, searchLimits, type SearchToolOptions } from "./search.js";

/** @experimental */
export interface GlobInput {
  readonly pattern: string;
  readonly path?: string | undefined;
  readonly includeHidden?: boolean | undefined;
}

/** @experimental */
export interface GlobOutput {
  readonly paths: readonly string[];
  readonly truncated: boolean;
}

/** @experimental */
export function createGlobTool(options: SearchToolOptions): Tool<GlobInput, GlobOutput> {
  const limits = searchLimits(options);
  return defineTool({
    name: "glob",
    workspaceEffect: "read",
    description:
      "Find workspace files by glob pattern, respecting .gitignore. Prefer this tool over shell commands when locating files by name. Hidden files are optional; symbolic links are not followed.",
    schema: z
      .object({ pattern: z.string().min(1), path: z.string().min(1).optional(), includeHidden: z.boolean().optional() })
      .strict(),
    async execute(input, context) {
      const args = ["--files", "--null", "--glob", input.pattern];
      if (input.includeHidden) args.push("--hidden");
      const allowedArgs = ["--files", "--null"];
      if (input.includeHidden) allowedArgs.push("--hidden");
      const allowedResult = await runSearch(options, allowedArgs, input.path ?? ".", context.signal);
      const allowed = new Set(allowedResult.data.toString("utf8").split("\0").slice(0, -1));
      const result = await runSearch(options, args, input.path ?? ".", context.signal);
      const paths = result.data
        .toString("utf8")
        .split("\0")
        .slice(0, -1)
        .filter((path) => allowed.has(path));
      return {
        paths: paths.slice(0, limits.maxResults).map((path) => path.replaceAll("\\", "/").replace(/^\.\//u, "")),
        truncated: result.truncated || allowedResult.truncated || paths.length > limits.maxResults,
      };
    },
  });
}
