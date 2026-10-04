import type { AgentApplicationEvent } from "@may/application";
import type { MaybeCodeModelInfo } from "./controller.js";
import type { ToolChangePreview } from "@may/coding-tools/change-preview";
import type { McpClientEvent, McpInteractionEvent } from "@may/mcp";
import type { MaybeCodeDelegationEvent } from "./delegation.js";
export type { MaybeCodeRun } from "./delegation.js";

export type MaybeCodeSessionEvent =
  | { type: "workspace.git.changed"; checkpoint: import("@may/application/git-workspace").GitCheckpoint }
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
  | import("@may/application").AgentSessionForkedEvent
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
