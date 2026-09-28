import type { Tool } from "@may/core";
import { learnSkill, RuleBook } from "../growth/rule-book.js";
import type { Vault } from "../vault/vault.js";
import { defineTool, optionalStringList, readObject, requiredString } from "./define.js";

export function createGrowthTools(vault: Vault, ruleBook: RuleBook): readonly Tool[] {
  const learnRule = defineTool<{ title: string; rule: string; scope?: string; tags?: readonly string[] }, {
    path: string;
    scope: string;
  }>({
    name: "rule_learn",
    description:
      "记录用户纠正过的一条判断标准，写入个人数据库的 rules 目录。" +
      "规则会在之后每个新会话的系统提示中出现，例如「报名截止时间不是活动开始时间」。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        rule: { type: "string" },
        scope: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title", "rule"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "rule_learn");
      const scope = optionalStringScope(record);
      const tags = optionalStringList(record, "tags", "rule_learn");
      return {
        title: requiredString(record, "title", "rule_learn", 200),
        rule: requiredString(record, "rule", "rule_learn", 8_000),
        ...(scope === undefined ? {} : { scope }),
        ...(tags === undefined ? {} : { tags }),
      };
    },
    async execute(input) {
      const record = await ruleBook.learn({
        title: input.title,
        rule: input.rule,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
      });
      return { path: record.path, scope: record.scope };
    },
  });

  const listRules = defineTool<Record<string, never>, { rules: readonly unknown[] }>({
    name: "rule_list",
    description: "列出已经记录的用户规则。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    parse(input) {
      readObject(input, "rule_list");
      return {};
    },
    async execute() {
      const rules = await ruleBook.list();
      return {
        rules: rules.map((rule) => ({
          path: rule.path,
          title: rule.title,
          scope: rule.scope,
          createdAt: rule.createdAt,
          text: rule.text,
        })),
      };
    },
  });

  const learnProcedure = defineTool<{ name: string; description: string; body: string }, { name: string; path: string }>({
    name: "skill_learn",
    description:
      "把一次成功的处理流程写成技能文件，保存到个人数据库的 skills 目录。" +
      "技能会在新会话中出现在技能目录里，可以被 skill_read 读取并按步骤执行。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, description: { type: "string" }, body: { type: "string" } },
      required: ["name", "description", "body"],
      additionalProperties: false,
    },
    parse(input) {
      const record = readObject(input, "skill_learn");
      return {
        name: requiredString(record, "name", "skill_learn", 64),
        description: requiredString(record, "description", "skill_learn", 1_024),
        body: requiredString(record, "body", "skill_learn", 32 * 1024),
      };
    },
    async execute(input) {
      return learnSkill(vault, input);
    },
  });

  return [learnRule, listRules, learnProcedure];
}

function optionalStringScope(record: Record<string, unknown>): string | undefined {
  const value = record.scope;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError("rule_learn 的 scope 必须是字符串");
  const text = value.trim();
  return text === "" || text.length > 200 ? undefined : text;
}
