import { mkdir } from "node:fs/promises";
import { atomicWriteText } from "./atomic-write.js";
import { dirname } from "node:path";
import type { Tool } from "@may/core";
import type { EnvironmentProvider } from "@may/environment";
import {
  requireObject,
  requirePositiveIntegerOption,
  requireString,
} from "./input.js";
import { assertTextWithinLimit } from "./text-file.js";
import { resolveWritableWorkspacePath } from "./workspace-path.js";
import { assertFileExistence, type WorkspaceFileGuard } from "./guard.js";

export const DEFAULT_WRITE_MAX_BYTES = 1024 * 1024;

export interface WriteToolOptions {
  readonly environment?: EnvironmentProvider;
  readonly cwd: string;
  readonly maxBytes?: number;
  readonly allowHardLinks?: boolean;
  /** 宿主守卫：在同一把文件锁内完成检查与写入。 */
  readonly guard?: WorkspaceFileGuard;
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
      const file = await resolveWritableWorkspacePath(options.cwd, input.path, {
        allowHardLinks: options.allowHardLinks === true,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
        signal: context.signal,
      });
      const bytesWritten = assertTextWithinLimit(
        input.content,
        file.relative,
        maxBytes,
      );
      const write = async () => {
        context.signal.throwIfAborted();
        if (options.environment === undefined) await mkdir(dirname(file.absolute), { recursive: true });
        context.signal.throwIfAborted();
        await atomicWriteText(file.absolute, input.content, context.signal, options.environment, file.relative);
        return { output: { path: file.relative, bytesWritten }, content: input.content };
      };
      if (options.guard === undefined) return (await write()).output;
      const exists = await assertFileExistence(file, context.signal, options.environment);
      return (await options.guard<{ readonly output: WriteToolOutput; readonly content: string }>({
        tool: "write",
        path: file,
        exists,
        run: write,
      })).output;
    },
  };
}
