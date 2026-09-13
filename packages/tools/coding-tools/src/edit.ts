import { atomicWriteText } from "./atomic-write.js";
import type { Tool } from "@may/core";
import { CodingToolError } from "./errors.js";
import {
  requireObject,
  requirePositiveIntegerOption,
  requireString,
} from "./input.js";
import { assertTextWithinLimit, readTextFile } from "./text-file.js";
import { resolveExistingWorkspacePath } from "./workspace-path.js";

export const DEFAULT_EDIT_MAX_BYTES = 1024 * 1024;

export interface EditToolOptions {
  readonly cwd: string;
  readonly maxBytes?: number;
  readonly allowHardLinks?: boolean;
}

export interface EditToolInput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

export interface EditToolOutput {
  readonly path: string;
  readonly replacements: 1;
}

export function createEditTool(options: EditToolOptions): Tool<
  EditToolInput,
  EditToolOutput
> {
  const maxBytes = requirePositiveIntegerOption(
    options.maxBytes,
    DEFAULT_EDIT_MAX_BYTES,
    "maxBytes",
  );

  return {
    name: "edit",
    description: "Replace one exact, unique text occurrence in a workspace file.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        oldText: { type: "string", minLength: 1, description: "Exact text to replace" },
        newText: { type: "string", description: "Replacement text" },
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false,
    },
    parse(input) {
      const value = requireObject(input, "edit");
      return {
        path: requireString(value.path, "edit", "path"),
        oldText: requireString(value.oldText, "edit", "oldText"),
        newText: requireString(value.newText, "edit", "newText", {
          allowEmpty: true,
        }),
      };
    },
    async execute(input, context) {
      const file = await resolveExistingWorkspacePath(options.cwd, input.path, {
        allowHardLinks: options.allowHardLinks === true,
      });
      const original = await readTextFile(
        file.absolute,
        file.relative,
        maxBytes,
        context.signal,
      );
      const occurrences = countOccurrences(original, input.oldText, 2);
      if (occurrences === 0) {
        throw new CodingToolError(
          "CODING_TOOL_EDIT_NOT_FOUND",
          `edit: oldText was not found in ${file.relative}`,
        );
      }
      if (occurrences > 1) {
        throw new CodingToolError(
          "CODING_TOOL_EDIT_AMBIGUOUS",
          `edit: oldText occurs more than once in ${file.relative}`,
        );
      }

      const updated = original.replace(input.oldText, () => input.newText);
      assertTextWithinLimit(updated, file.relative, maxBytes);
      context.signal.throwIfAborted();
      await atomicWriteText(file.absolute, updated, context.signal);
      return { path: file.relative, replacements: 1 };
    },
  };
}

function countOccurrences(source: string, search: string, stopAt: number): number {
  let count = 0;
  let offset = 0;
  while (offset <= source.length - search.length) {
    const match = source.indexOf(search, offset);
    if (match === -1) break;
    count += 1;
    if (count >= stopAt) break;
    offset = match + 1;
  }
  return count;
}
