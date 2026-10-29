import type { ServiceToken } from "../plugin/index.js";
import type { SessionBranchCompletionOptions, SessionBranchPosition, SessionRecovery } from "../session/index.js";
import type { ContinuableAgentController } from "./controller.js";

export interface ApplicationExecution extends Pick<ContinuableAgentController,
  "sessionId" | "isRunning" | "submit" | "continue" | "resolveApproval"> {}

export interface ApplicationHistory extends Pick<ContinuableAgentController, "history" | "queryHistory"> {
  branchPositions(): Promise<readonly SessionBranchPosition[]>;
  saveBranchPosition(runId: string, options?: SessionBranchCompletionOptions): Promise<void>;
  listRecoveries(): readonly SessionRecovery[];
}

export interface ApplicationState {
  recordState(key: string, value: unknown): Promise<void>;
}

export interface ApplicationFacade extends ApplicationExecution, ApplicationHistory, ApplicationState {
  getService<T>(service: ServiceToken<T>): T;
  getOptionalService<T>(service: ServiceToken<T>): T | undefined;
}

export interface ApplicationServiceAccess<T> { get(): T }
export type ApplicationAccess = ApplicationServiceAccess<ApplicationFacade>;

export function createApplicationAccess(resolve: () => ApplicationFacade) {
  const execution = Object.freeze<ApplicationExecution>({
    get sessionId() { return resolve().sessionId; },
    get isRunning() { return resolve().isRunning; },
    submit: options => resolve().submit(options),
    continue: options => resolve().continue(options),
    resolveApproval: (requestId, decision, options) => resolve().resolveApproval(requestId, decision, options),
  });
  const history = Object.freeze<ApplicationHistory>({
    history: () => resolve().history(),
    queryHistory: query => resolve().queryHistory(query),
    branchPositions: () => resolve().branchPositions(),
    saveBranchPosition: (runId, options) => resolve().saveBranchPosition(runId, options),
    listRecoveries: () => resolve().listRecoveries(),
  });
  const state = Object.freeze<ApplicationState>({ recordState: (key, value) => resolve().recordState(key, value) });
  const application = Object.freeze<ApplicationFacade>({
    ...history, ...state,
    get sessionId() { return execution.sessionId; },
    get isRunning() { return execution.isRunning; },
    submit: execution.submit,
    continue: execution.continue,
    resolveApproval: execution.resolveApproval,
    getService: <T>(service: ServiceToken<T>) => resolve().getService(service),
    getOptionalService: <T>(service: ServiceToken<T>) => resolve().getOptionalService(service),
  });
  const access = <T>(value: T): ApplicationServiceAccess<T> => Object.freeze({ get() { resolve(); return value; } });
  return Object.freeze({ application: access(application), execution: access(execution), history: access(history), state: access(state) });
}
