import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Tool } from "@sortedyuan/may/core";
import {
  createCodingTool,
  workspaceFileKey,
  type CodingToolName,
  type CodingToolsOptions,
  type WorkspaceFileOperation,
  type WorkspaceFileGuard,
} from "@sortedyuan/coding-tools";
import type { SubagentToolName } from "./subagents.js";

/** @experimental */
export interface SubagentFileGuard {
  readonly tools: readonly Tool[];
  /** 本任务通过文件工具修改过的工作区相对路径。 */
  changedFiles(): readonly string[];
  /** 供任务输出使用的宿主记录，让父 Agent 重新读取后再修改。 */
  note(): string;
}

/**
 * 共享工作区的文件互斥与版本保护。
 *
 * 同一工作区内主任务与全部子任务共用一把按规范化路径取得的锁，因此
 * “读取并记录版本”与“检查并写入”各自在锁内完成，两个任务的写入不会交错。
 * 版本记录按任务分开保存：每个任务只与它自己读到过的内容比较。
 *
 * 保证范围：锁只在进程内生效，覆盖本应用提供的文件工具；工作区之外的进程
 * （例如用户自己打开的 shell、编辑器或其他程序）不受本守卫约束，任务指令中
 * 说明了这一点。符号链接与别名解析为同一把锁。
 * @experimental
 */
export class SharedWorkspaceFileGuard {
  private readonly workspace: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    workspace: string,
    private readonly options: Pick<CodingToolsOptions, "execution" | "fetch" | "fileFeedback"> & {
      readonly toolFactories?: Readonly<Record<string, (guard: WorkspaceFileGuard) => Tool>>;
    } = {},
  ) {
    this.workspace = workspace;
  }

  /**
   * 创建一个任务的文件工具集合。
   *
   * `files` 是该任务被允许修改的工作区相对路径，缺省表示不限制；读取不受它限制。
   * `requireRead` 为 true 时（本项目的子 Agent），已有内容的文件必须先读取才能修改；
   * 为 false 时（主任务）保持原有的直接写入能力，但如果本任务读过该文件，
   * 之后文件发生变化时仍然拒绝写入。
   */
  create(options: {
    readonly names: readonly SubagentToolName[];
    readonly files?: readonly string[];
    readonly requireRead: boolean;
  }): SubagentFileGuard {
    const scope = options.files === undefined ? undefined : new Set(options.files.map(normalizeRelative));
    const versions = new Map<string, string>();
    const changed = new Set<string>();

    /** 同一路径的文件操作串行执行；锁覆盖“检查并写入”与“读取并记录版本”。 */
    const serialize = <T>(key: string, operation: () => Promise<T>): Promise<T> => {
      const previous = this.locks.get(key) ?? Promise.resolve();
      const result = previous.then(operation, operation);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      this.locks.set(key, tail);
      return result.finally(() => {
        if (this.locks.get(key) === tail) this.locks.delete(key);
      });
    };

    const checkScope = (path: { readonly relative: string }, tool: WorkspaceFileOperation<unknown>["tool"]) => {
      const relative = normalizeRelative(path.relative);
      // 声明的文件只约束修改；读取在工作区内不受限制。
      if (tool !== "read" && scope !== undefined && !scope.has(relative)) {
        throw new Error(
          (scope.size === 0
            ? "File conflict: this task may not modify files; "
            : `File conflict: this task may only modify ${[...scope].join(", ")}; `) +
            `${relative} is outside its assigned files. Ask the main agent for a different assignment.`,
        );
      }
    };

    const checkVersion = async (key: string, relative: string) => {
      const current = await version(key);
      const known = versions.get(key);
      if (options.requireRead && known === undefined && current !== MISSING) {
        throw new Error(
          `File conflict: ${relative} exists and this task has not read it. ` +
            "Read it first, then decide whether to change it.",
        );
      }
      if (known !== undefined && known !== current) {
        throw new Error(
          `File conflict: ${relative} changed after this task read it. ` +
            "Re-read the file and redo the change against the current content.",
        );
      }
    };

    const guard: WorkspaceFileGuard = async <T>(operation: WorkspaceFileOperation<T>): Promise<T> => {
      const key = workspaceFileKey(operation.path);
      const relative = normalizeRelative(operation.path.relative);
      checkScope(operation.path, operation.tool);
      return serialize(key, async () => {
        if (operation.tool === "read") {
          const value = await operation.run();
          versions.set(key, digest(contentOf(value)));
          return value;
        }
        // 在锁内读取当前版本，避免使用进入锁之前的状态。
        await checkVersion(key, relative);
        const value = await operation.run();
        versions.set(key, digest(contentOf(value)));
        changed.add(relative);
        return value;
      });
    };

    guard.runMany = async (paths, tool, operation) => {
      for (const path of paths) checkScope(path, tool);
      const entries = [...new Map(paths.map((path) => [workspaceFileKey(path), path])).entries()].sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      );
      const runLocked = async (index: number): Promise<Awaited<ReturnType<typeof operation>>> => {
        const entry = entries[index];
        if (entry !== undefined) return serialize(entry[0], () => runLocked(index + 1));
        if (tool !== "read") {
          for (const [key, path] of entries) await checkVersion(key, normalizeRelative(path.relative));
        }
        const value = await operation();
        for (const [key, path] of entries) {
          versions.set(key, await version(key));
          if (tool !== "read") changed.add(normalizeRelative(path.relative));
        }
        return value;
      };
      return runLocked(0);
    };

    return {
      tools: options.names.map((name) => {
        if (["read", "shell", "edit", "write", "glob", "grep", "fetch"].includes(name)) {
          return createCodingTool(name as CodingToolName, { cwd: this.workspace, ...this.options, guard });
        }
        const factory = Object.hasOwn(this.options.toolFactories ?? {}, name)
          ? this.options.toolFactories![name]
          : undefined;
        if (factory === undefined) throw new Error(`Unknown sub-agent tool: ${name}`);
        const tool = factory(guard);
        if (tool.name !== name) throw new Error(`Tool factory ${name} returned tool ${tool.name}`);
        return tool;
      }),
      changedFiles: () => [...changed],
      note: () =>
        changed.size === 0
          ? ""
          : `\n\nHost record: this task changed these workspace files through the file tools: ${[...changed].join(", ")}. ` +
            "Another task may have changed them since; read a file before editing it.",
    };
  }
}

const MISSING = "missing";
// 与 coding-tools 的 readTextFile 保持一致的解码方式，BOM 保留在字符串中。
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * 锁内读取当前内容版本；工具已经校验过路径包含关系与非硬链接。
 *
 * 无法解码为 UTF-8 文本的文件得到固定标记：它无法被 read 工具读取，
 * 因此受保护的任务不会覆盖它，宿主会看到“文件冲突”。
 */
async function version(path: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return MISSING;
    }
    throw error;
  }
  try {
    return digest(DECODER.decode(bytes));
  } catch {
    return "unreadable";
  }
}

function contentOf(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content: unknown }).content;
    return typeof content === "string" ? content : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function digest(content: string | undefined): string {
  return content === undefined ? MISSING : createHash("sha256").update(content).digest("hex");
}

/** 统一的相对路径写法：正斜杠、无前导 "./"；Windows 上比较不区分大小写。 */
function normalizeRelative(path: string): string {
  const normalized = path.replace(/\\/gu, "/").replace(/^\.\//u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
