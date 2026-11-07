import { defineTool, type Tool } from "@sortedyuan/may/core";
import { z } from "zod";
import { runSearch, searchLimits, type SearchToolOptions } from "./search.js";

/** @experimental */
export interface GrepInput {
  readonly pattern: string;
  readonly path?: string | undefined;
  readonly glob?: string | undefined;
  readonly literal?: boolean | undefined;
  readonly caseSensitive?: boolean | undefined;
}

/** @experimental */
export interface GrepOutput {
  readonly matches: readonly { readonly file: string; readonly line: number; readonly text: string }[];
  readonly truncated: boolean;
}

const eventSchema = z.object({
  type: z.string(),
  data: z.unknown(),
});
const matchSchema = z.object({
  path: z.object({ text: z.string() }),
  lines: z.object({ text: z.string() }),
  line_number: z.number().int().positive(),
});

/** @experimental */
export function createGrepTool(options: SearchToolOptions): Tool<GrepInput, GrepOutput> {
  const limits = searchLimits(options);
  return defineTool({
    name: "grep",
    workspaceEffect: "read",
    description:
      "Search workspace file contents using a regex or literal text, respecting .gitignore. Prefer this tool over shell commands for finding matching lines with file names and line numbers. Symbolic links are not followed.",
    schema: z
      .object({
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        glob: z.string().min(1).optional(),
        literal: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
      })
      .strict(),
    async execute(input, context) {
      const args = ["--json", "--no-messages", "--regexp", input.pattern];
      if (input.glob !== undefined) args.push("--glob", input.glob);
      if (input.literal) args.push("--fixed-strings");
      args.push(input.caseSensitive === false ? "--ignore-case" : "--case-sensitive");
      const allowedResult =
        input.glob === undefined
          ? undefined
          : await runSearch(options, ["--files", "--null"], input.path ?? ".", context.signal);
      const allowed =
        allowedResult === undefined ? undefined : new Set(allowedResult.data.toString("utf8").split("\0").slice(0, -1));
      const result = await runSearch(options, args, input.path ?? ".", context.signal);
      const matches: { file: string; line: number; text: string }[] = [];
      let truncated = result.truncated || allowedResult?.truncated === true;
      for (const line of result.data.toString("utf8").split("\n").slice(0, -1)) {
        const event = eventSchema.parse(JSON.parse(line));
        if (event.type !== "match") continue;
        const match = matchSchema.parse(event.data);
        if (allowed !== undefined && !allowed.has(match.path.text)) continue;
        if (matches.length === limits.maxResults) {
          truncated = true;
          break;
        }
        matches.push({
          file: match.path.text.replaceAll("\\", "/").replace(/^\.\//u, ""),
          line: match.line_number,
          text: match.lines.text.replace(/\r?\n$/u, ""),
        });
      }
      return { matches, truncated };
    },
  });
}
