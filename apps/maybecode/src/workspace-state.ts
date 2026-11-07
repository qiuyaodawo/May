import type { AgentWorkspace } from "@sortedyuan/may";
import type { ProjectGitWorkspace } from "@sortedyuan/may/application/git-workspace";
import type { MaybeCodeApplication } from "./application.js";
import type { MaybeCodeCompactionSelection } from "./controller.js";
import type { MaybeCodeEvent, MaybeCodeRun, MaybeCodeSessionEvent } from "./events.js";
import type { MaybeCodeWorkspaceOptions } from "./workspace.js";

export type MaybeCodeProductEvent = Exclude<
  MaybeCodeEvent,
  | MaybeCodeSessionEvent
  | {
      type: "session.changed";
      sessionId: string;
      resumed: boolean;
    }
>;

export type ActiveWorkspaceOptions = Omit<MaybeCodeWorkspaceOptions, "sessionId" | "autoResume">;

export interface WorkspaceState {
  options: ActiveWorkspaceOptions;
  readonly rootWorkspace: string;
  readonly git: Map<string, ProjectGitWorkspace>;
  readonly createdSessions: Map<string, string>;
}

export type BaseWorkspace = AgentWorkspace<
  MaybeCodeSessionEvent,
  MaybeCodeProductEvent,
  MaybeCodeCompactionSelection,
  MaybeCodeRun,
  MaybeCodeApplication
>;
