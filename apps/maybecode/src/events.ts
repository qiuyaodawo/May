import type { AgentApplicationEvent, AgentRun } from "@may/application";
import type { MaybeCodeModelInfo } from "./controller.js";
import type { ToolChangePreview } from "@may/coding-tools/change-preview";

export type MaybeCodeSessionEvent =
  | Exclude<AgentApplicationEvent, { type: "tool.presentation" }>
  | {
      type: "change.preview";
      runId: string;
      step: number;
      toolCallId: string;
      preview: ToolChangePreview;
    };

export type MaybeCodeEvent =
  | MaybeCodeSessionEvent
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

export type MaybeCodeRun = AgentRun;
