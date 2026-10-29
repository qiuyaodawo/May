import type { Model } from "../core/index.js";
import type { ContextSummarizer } from "../context/index.js";
import {
  createModelContextSummarizer as createReusableModelContextSummarizer,
} from "../context/model-summarizer.js";

const SUMMARY_INSTRUCTIONS = `Summarize the preceding coding-agent conversation for continuation.
Return only a concise, factual working-state summary. Preserve the user's goals
and constraints, decisions, files changed, commands and test outcomes, current
errors, and remaining work. Do not invent details and do not call tools.`;

const SUMMARY_REQUEST = "Produce the continuation summary now.";

/** 创建用于编码会话继续执行的 Model summarizer。 */
export function createModelContextSummarizer(model: Model): ContextSummarizer {
  return createReusableModelContextSummarizer(model, {
    instructions: SUMMARY_INSTRUCTIONS,
    requestText: SUMMARY_REQUEST,
  });
}
