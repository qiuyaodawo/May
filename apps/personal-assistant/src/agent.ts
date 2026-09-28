import { AgentApplication, type AgentApplicationSelection } from "@may/application";
import {
  InMemoryContextFactory,
  PruneOldToolResultsStrategy,
  SummaryTailStrategy,
} from "@may/context";
import { createModelContextSummarizer } from "@may/context/model-summarizer";
import { ToolRegistry, type Model } from "@may/core";
import type { SessionStore } from "@may/session";
import { SkillRegistry } from "@may/skills";
import { join } from "node:path";
import { BASE_INSTRUCTIONS, SKILL_ROOTS_INSTRUCTIONS } from "./instructions.js";
import { createPermissionPolicy } from "./permissions.js";
import type { AssistantContext } from "./context.js";
import { createEhallTools } from "./tools/ehall-tools.js";
import { createGrowthTools } from "./tools/growth-tools.js";
import { createMailTools } from "./tools/mail-tools.js";
import { createVaultTools } from "./tools/vault-tools.js";

export interface AgentFactoryOptions {
  readonly context: AssistantContext;
  readonly model: Model;
  readonly store: SessionStore;
}

/** 工具集合：所有工具共享同一份个人数据库、邮箱与办事大厅状态。 */
export function createAssistantTools(context: AssistantContext): ToolRegistry {
  return ToolRegistry.compose(
    createVaultTools(context.vault),
    createMailTools(context.mailbox),
    createEhallTools(context.ehall),
    createGrowthTools(context.vault, context.rules),
  );
}

/**
 * 打开一个会话。规则与技能在打开时读取，
 * 因此新会话一定会带上用户最近记录的内容。
 */
export async function openAssistantApplication(
  options: AgentFactoryOptions,
  selection: AgentApplicationSelection,
): Promise<AgentApplication> {
  const { context, model, store } = options;
  const prune = new PruneOldToolResultsStrategy({ keepRecentToolResults: 4, minimumResultBytes: 2_048 });
  const summarize = new SummaryTailStrategy({
    summarizer: createModelContextSummarizer(model, {
      instructions: "把已经处理过的对话压缩成简洁的中文摘要，保留办过的事项、确认过的结论、待办和用户纠正过的规则。",
      requestText: "请总结到目前为止的对话，保留事实、结论、待办与用户要求。",
    }),
    keepRecentTurns: 3,
  });
  const [rules, skills] = await Promise.all([
    context.rules.instructions(),
    SkillRegistry.discover([{ directory: join(context.vault.root, "skills"), source: "个人数据库" }]),
  ]);
  const instructions = [
    BASE_INSTRUCTIONS,
    SKILL_ROOTS_INSTRUCTIONS,
    rules,
  ].filter((part) => part !== "").join("\n\n");

  return AgentApplication.open({
    model,
    store,
    tools: createAssistantTools(context),
    permissionPolicy: createPermissionPolicy({ vault: context.vault }),
    instructions,
    ...(skills.list().length === 0 ? {} : { skills }),
    contextFactory: new InMemoryContextFactory(),
    contextBudget: {
      contextWindowTokens: model.limits?.contextWindowTokens ?? 64_000,
      outputReserveTokens: model.limits?.maxOutputTokens ?? 4_096,
      toolReserveTokens: 4_096,
      safetyMarginTokens: 2_048,
      compactTriggerRatio: 0.85,
    },
    compactionStrategy: summarize,
    autoCompactionStrategies: [prune, summarize],
    sessionHistory: { maxEvents: 60, maxOutputBytes: 48 * 1_024, maxEventBytes: 16 * 1_024 },
    maxSteps: 24,
    runBudget: { maxSteps: 40, maxToolCalls: 60, maxDurationMs: 10 * 60_000 },
    metadata: { assistant: "personal-assistant", vault: context.vault.root },
    contextMetadata: { vault: context.vault.root },
    validateSession: (metadata) => {
      if (metadata?.assistant !== "personal-assistant") {
        throw new Error("这个会话不是个人助手创建的，拒绝在同一个会话上继续");
      }
    },
    ...(selection.sessionId === undefined ? {} : { sessionId: selection.sessionId }),
    ...(selection.resume ? { resume: true } : {}),
  });
}
