import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitError extends Error {
  constructor(readonly result: GitResult) {
    super(`git 失败（退出码 ${result.code}）：${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
  }
}

/** 只在指定目录内执行固定参数的 git 命令，参数不来自用户输入的任意文本。 */
export class GitRepository {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly directory: string) {}

  async isRepository(): Promise<boolean> {
    const result = await this.exec(["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async init(): Promise<void> {
    if (await this.isRepository()) return;
    await this.exec(["init", "--quiet"]);
    await this.exec(["config", "user.name", "Personal Assistant"], { allowFailure: true });
    await this.exec(["config", "user.email", "assistant@personal-assistant.local"], { allowFailure: true });
  }

  /** 提交当前改动；没有改动时不产生提交，返回 false。 */
  async commit(message: string, options: { readonly allow?: readonly string[] } = {}): Promise<boolean> {
    const subject = message.replace(/[\r\n]+/gu, " ").trim().slice(0, 200);
    if (subject === "") throw new Error("提交说明不能为空");
    const status = await this.exec(["status", "--porcelain", "--", ...(options.allow ?? ["."])]);
    if (status.stdout.trim() === "") return false;
    await this.exec(["add", "--all", "--", ...(options.allow ?? ["."])]);
    const result = await this.exec(["commit", "--quiet", "--message", subject], { allowFailure: true });
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`;
      if (/nothing to commit|no changes added to commit/iu.test(combined)) return false;
      throw new GitError(result);
    }
    return true;
  }

  async log(limit: number): Promise<readonly { hash: string; subject: string; date: string }[]> {
    const result = await this.exec(["log", `-${Math.max(1, Math.min(limit, 200))}`, "--pretty=format:%h\t%ad\t%s", "--date=short"]);
    if (result.code !== 0) return [];
    return result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [hash = "", date = "", ...rest] = line.split("\t");
        return { hash: hash ?? "", date: date ?? "", subject: rest.join("\t") };
      });
  }

  /** 工作区中未提交的条目数量。 */
  async pendingChanges(): Promise<number> {
    const result = await this.exec(["status", "--porcelain"]);
    return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
  }

  /** 顺序执行，避免并发 git 进程互相阻塞索引文件。 */
  private exec(
    args: readonly string[],
    options: { readonly allowFailure?: boolean } = {},
  ): Promise<GitResult> {
    const job = this.tail.then(async () => {
      try {
        const { stdout, stderr } = await run("git", [...args], {
          cwd: this.directory,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Personal Assistant",
            GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "assistant@personal-assistant.local",
            GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Personal Assistant",
            GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "assistant@personal-assistant.local",
          },
          maxBuffer: 8 * 1024 * 1024,
        });
        return { code: 0, stdout, stderr };
      } catch (error) {
        const failure = error as { code?: number; stdout?: string; stderr?: string };
        const result: GitResult = {
          code: typeof failure.code === "number" ? failure.code : 1,
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? String(error),
        };
        if (options.allowFailure === true) return result;
        throw new GitError(result);
      }
    });
    this.tail = job.then(() => undefined, () => undefined);
    return job;
  }
}
