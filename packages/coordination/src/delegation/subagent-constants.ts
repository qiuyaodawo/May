/** 主请求在协调图中的任务 id 与 agent 名称。
 * @experimental
 */
export const MAIN_TASK_ID = "request";
/** @experimental */
export const MAIN_AGENT = "main";
export const VERSION = "maybecode-subagent-v1";
export const OUTPUT_LIMIT = 4_000;
export const MAX_TOOL_RECORDS = 64;
export const MAX_INDEXED_REQUESTS = 16;

export function bounded(text: string, limit: number): string {
  return Buffer.byteLength(text, "utf8") <= limit ? text : `${text.slice(0, limit)}\n…[truncated]`;
}
