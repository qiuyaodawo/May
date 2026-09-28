import type { AgentApplicationEvent, AgentRun } from "@may/application";
import type { MaybeCodeModelInfo } from "./controller.js";
import type { ToolChangePreview } from "@may/coding-tools/change-preview";
import type { McpClientEvent, McpInteractionEvent } from "@may/mcp";
import type { MaybeCodeDelegationEvent, MaybeCodeRequestRun } from "./delegation.js";

export type MaybeCodeSessionEvent =
  | import("@may/goal").GoalEvent
  | MaybeCodeDelegationEvent
  | Exclude<AgentApplicationEvent, { type: "tool.presentation" }>
  | {
      type: "change.preview";
      runId: string;
      step: number;
      toolCallId: string;
      preview: ToolChangePreview;
    };

export type MaybeCodeEvent =
  | { type: "permission-mode.changed"; mode: import("./policy.js").MaybeCodePermissionMode }
  | MaybeCodeSessionEvent
  | McpClientEvent
  | McpInteractionEvent
  | { type: "mcp.resource.updated"; serverId: string; uri: string }
  | { type: "mcp.resource.watch-closed"; serverId: string; uri: string; reason: string }
  | {
      type: "session.changed";
      sessionId: string;
      resumed: boolean;
    }
  | {
      type: "model.changed";
      model: MaybeCodeModelInfo;
    }
  | {
      type: "model.default.changed";
      profile: string;
    };

/**
 * 一次用户请求，而不一定是一个 Run。
 *
 * 一次请求可能在主 Session 中执行多个 Run：进行委派的 Run 交出名额，
 * 子任务在自己的 Session 中运行，主 Session 继续执行直到请求得到最终结果。
 */
export interface MaybeCodeRun extends AgentRun {
  readonly requestId: string;
  /** 本请求真实 Run 的身份与结果，按执行顺序返回。 */
  runs(): Promise<readonly MaybeCodeRequestRun[]>;
}
