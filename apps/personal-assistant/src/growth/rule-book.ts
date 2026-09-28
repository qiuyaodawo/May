import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatMarkdown, parseMarkdown } from "../vault/frontmatter.js";
import { isMissing } from "../vault/paths.js";
import type { Vault } from "../vault/vault.js";

export const RULE_DIRECTORY = "rules";
export const SKILL_DIRECTORY = "skills";
const MAX_RULE_BYTES = 64 * 1024;
const MAX_RULES = 200;

export interface RuleRecord {
  readonly path: string;
  readonly title: string;
  readonly createdAt: string;
  readonly scope: string;
  readonly text: string;
}

export interface RuleInput {
  readonly title: string;
  readonly rule: string;
  readonly scope?: string;
  readonly tags?: readonly string[];
}

/**
 * 规则库：用户纠正过的判断标准保存在个人数据库里，
 * 每个新会话都会把它们放进系统提示，换一次会话也照样生效。
 */
export class RuleBook {
  constructor(private readonly vault: Vault) {}

  async learn(input: RuleInput): Promise<RuleRecord> {
    const title = input.title.trim();
    const rule = input.rule.trim();
    if (title === "") throw new Error("规则标题不能为空");
    if (rule === "") throw new Error("规则内容不能为空");
    if (Buffer.byteLength(rule, "utf8") > 8_000) throw new Error("单条规则超过 8000 字节");
    const existing = await this.list();
    if (existing.length >= MAX_RULES) throw new Error(`规则数量超过 ${MAX_RULES}`);
    const createdAt = new Date().toISOString();
    const path = `${RULE_DIRECTORY}/${createdAt.slice(0, 10)}-${slug(title)}-${existing.length + 1}.md`;
    const body = [
      `- 规则：${rule}`,
      "",
      input.scope === undefined || input.scope.trim() === "" ? "" : `适用范围：${input.scope.trim()}`,
      "",
      "来源：用户在对话中纠正后由助手记录。修改本文件即可改变后续行为。",
      "",
    ].filter((line) => line !== "").join("\n");
    const entry = await this.vault.write(path, formatMarkdown({
      title,
      tags: ["rule", ...(input.tags ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== "")],
      createdAt,
      ...(input.scope === undefined || input.scope.trim() === "" ? {} : { scope: input.scope.trim() }),
    }, body));
    await this.vault.git.commit(`记录规则：${title}`);
    return {
      path: entry.path,
      title,
      createdAt,
      scope: input.scope?.trim() ?? "全部任务",
      text: rule,
    };
  }

  async list(): Promise<readonly RuleRecord[]> {
    const directory = join(this.vault.root, RULE_DIRECTORY);
    const names = await readdir(directory).catch((error: unknown) => {
      if (isMissing(error)) return [] as string[];
      throw error;
    });
    const rules: RuleRecord[] = [];
    for (const name of names.filter((item) => item.endsWith(".md")).sort()) {
      const path = `${RULE_DIRECTORY}/${name}`;
      const source = await readFile(join(directory, name), "utf8");
      if (Buffer.byteLength(source, "utf8") > MAX_RULE_BYTES) {
        throw new Error(`规则文件超过 ${MAX_RULE_BYTES} 字节：${path}`);
      }
      const parsed = parseMarkdown(source);
      rules.push({
        path,
        title: typeof parsed.data.title === "string" ? parsed.data.title : name.replace(/\.md$/u, ""),
        createdAt: typeof parsed.data.createdAt === "string" ? parsed.data.createdAt : "",
        scope: typeof parsed.data.scope === "string" ? parsed.data.scope : "全部任务",
        text: parsed.body.replace(/^-\s*规则：/mu, "").split("\n").filter((line) => line.trim() !== "")[0]?.trim() ?? "",
      });
    }
    return rules;
  }

  /** 生成放进系统提示的规则段落。没有规则时返回空字符串。 */
  async instructions(): Promise<string> {
    const rules = await this.list();
    if (rules.length === 0) return "";
    const lines = rules.map((rule, index) =>
      `${index + 1}. [${rule.scope}] ${rule.text}（记录于 ${rule.createdAt.slice(0, 10) || "未知日期"}，${rule.path}）`);
    return [
      "## 用户纠正后的规则",
      "这些规则来自用户以往的具体纠正，优先级高于你的默认习惯。每次任务都要检查是否适用；",
      "规则本身可能有冲突或过期，遇到冲突要向用户说明，不要自行选择其中一条。",
      ...lines,
    ].join("\n");
  }
}

/** 把一次成功的流程写成 Agent Skill，下次换会话也能按同样的步骤执行。 */
export async function learnSkill(
  vault: Vault,
  input: { name: string; description: string; body: string },
): Promise<{ name: string; path: string }> {
  const name = input.name.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) || name.length > 64) {
    throw new Error("技能名称只能使用小写字母、数字和连字符，且不超过 64 个字符");
  }
  const description = input.description.trim();
  if (description === "" || description.length > 1_024) throw new Error("技能描述长度需要在 1 到 1024 个字符之间");
  const body = input.body.trim();
  if (body === "") throw new Error("技能内容不能为空");
  if (Buffer.byteLength(body, "utf8") > 32 * 1024) throw new Error("技能内容超过 32 KiB");
  const path = `${SKILL_DIRECTORY}/${name}/SKILL.md`;
  const source = formatMarkdown({ name, description }, `${body}\n`);
  await vault.write(path, source);
  await vault.git.commit(`记录技能：${name}`);
  return { name, path };
}

function slug(title: string): string {
  const cleaned = title.replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 30);
  return cleaned === "" ? "rule" : cleaned;
}
