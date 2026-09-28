import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseSkill } from "@may/skills";
import { isMissing } from "../vault/paths.js";
import { SKILL_DIRECTORY } from "./rule-book.js";
import type { Vault } from "../vault/vault.js";

const BUILT_IN_SKILLS = ["notice-to-apply"];

/**
 * 首次使用时把内置技能写入个人数据库。
 * 用户可以直接阅读和修改这些文件，助手下次会话按修改后的内容执行。
 */
export async function seedSkills(vault: Vault): Promise<readonly string[]> {
  const directory = join(vault.root, SKILL_DIRECTORY);
  const existing = await readdir(directory).catch((error: unknown) => {
    if (isMissing(error)) return [] as string[];
    throw error;
  });
  if (existing.length > 0) return [];
  const seeded: string[] = [];
  for (const name of BUILT_IN_SKILLS) {
    const source = await readFile(new URL(`../../assets/skills/${name}/SKILL.md`, import.meta.url), "utf8");
    parseSkill(source, name);
    await vault.write(`${SKILL_DIRECTORY}/${name}/SKILL.md`, source);
    seeded.push(name);
  }
  return seeded;
}
