import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool } from "@may/core";
import {
  requireObject,
  requirePositiveIntegerOption,
  requireString,
} from "./input.js";
import { assertTextWithinLimit } from "./text-file.js";
import { resolveWritableWorkspacePath } from "./workspace-path.js";

export const DEFAULT_WRITE_MAX_BYTES = 1024 * 1024;

export interface WriteToolOptions {
  readonly cwd: string;
  readonly maxBytes?: number;
}

export interface WriteToolInput {
  readonly path: string;
  readonly content: string;
}

export interface WriteToolOutput {
  readonly path: string;
  readonly bytesWritten: number;
}

export function createWriteTool(options: WriteToolOptions): Tool<
  WriteToolInput,
  WriteToolOutput
> {
  const maxBytes = requirePositiveIntegerOption(
    options.maxBytes,
    DEFAULT_WRITE_MAX_BYTES,
    "maxBytes",
  );

  return {
    name: "write",
    description: "Create or overwrite a UTF-8 text file inside the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace" },
        content: { type: "string", description: "Complete file contents" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    parse(input) {
      const value = requireObject(input, "write");
      return {
        path: requireString(value.path, "write", "path"),
        content: requireString(value.content, "write", "content", {
          allowEmpty: true,
        }),
      };
    },
    async execute(input, context) {
      const file = await resolveWritableWorkspacePath(options.cwd, input.path);
      const bytesWritten = assertTextWithinLimit(
        input.content,
        file.relative,
        maxBytes,
      );
      context.signal.throwIfAborted();
      await mkdir(dirname(file.absolute), { recursive: true });
      context.signal.throwIfAborted();
      await writeFile(file.absolute, input.content, {
        encoding: "utf8",
        signal: context.signal,
      });
      return { path: file.relative, bytesWritten };
    },
  };
}
