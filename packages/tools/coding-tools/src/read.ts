import type { Tool } from "@may/core";
import { CodingToolError } from "./errors.js";
import {
  optionalPositiveInteger,
  requireObject,
  requirePositiveIntegerOption,
  requireString,
} from "./input.js";
import { readTextFile } from "./text-file.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

export const DEFAULT_READ_MAX_BYTES = 1024 * 1024;
export const DEFAULT_READ_MAX_LINES = 2000;

export interface ReadToolOptions {
  readonly cwd: string;
  readonly maxBytes?: number;
  readonly maxLines?: number;
  readonly allowHardLinks?: boolean;
}

export interface ReadToolInput {
  readonly path: string;
  /** One-based line number. */
  readonly offset?: number;
  readonly limit?: number;
}

export interface ReadToolOutput {
  readonly path: string;
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly truncated: boolean;
}

export function createReadTool(options: ReadToolOptions): Tool<
  ReadToolInput,
  ReadToolOutput
> {
  const maxBytes = requirePositiveIntegerOption(
    options.maxBytes,
    DEFAULT_READ_MAX_BYTES,
    "maxBytes",
  );
  const maxLines = requirePositiveIntegerOption(
    options.maxLines,
    DEFAULT_READ_MAX_LINES,
    "maxLines",
  );

  return {
    name: "read",
    description: "Read a UTF-8 text file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        offset: { type: "integer", minimum: 1, description: "First line to read (one-based)" },
        limit: { type: "integer", minimum: 1, maximum: maxLines, description: "Maximum lines to return" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    parse(input) {
      const value = requireObject(input, "read");
      const path = requireString(value.path, "read", "path");
      const offset = optionalPositiveInteger(value.offset, "read", "offset");
      const limit = optionalPositiveInteger(value.limit, "read", "limit");
      if (limit !== undefined && limit > maxLines) {
        throw new CodingToolError(
          "CODING_TOOL_INVALID_INPUT",
          `read: limit must not exceed ${maxLines}`,
        );
      }
      return {
        path,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
      };
    },
    async execute(input, context) {
      const file = await resolveExistingWorkspacePath(options.cwd, input.path, {
        allowHardLinks: options.allowHardLinks === true,
      });
      const text = await readTextFile(
        file.absolute,
        file.relative,
        maxBytes,
        context.signal,
      );
      const lines = text === "" ? [] : text.split(/\r\n|\n|\r/);
      const offset = input.offset ?? 1;
      if (offset > Math.max(lines.length, 1)) {
        throw new CodingToolError(
          "CODING_TOOL_READ_RANGE",
          `read: offset ${offset} exceeds ${lines.length} lines in ${file.relative}`,
        );
      }
      const selected = lines.slice(offset - 1, offset - 1 + (input.limit ?? maxLines));
      const startLine = selected.length === 0 ? 0 : offset;
      const endLine = selected.length === 0 ? 0 : offset + selected.length - 1;
      return {
        path: file.relative,
        content: selected.join("\n"),
        startLine,
        endLine,
        totalLines: lines.length,
        truncated: startLine > 1 || endLine < lines.length,
      };
    },
  };
}
