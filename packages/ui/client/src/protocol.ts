/** JSON-only presentation contract. Host policy, not this manifest, grants authority. */
export interface UiProduct {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly resourceKind: "session" | "task";
  readonly suggestions: readonly string[];
}

export interface UiResource {
  readonly id: string;
  readonly kind: "session" | "task";
  readonly title: string;
  readonly status: string;
  readonly updatedAt: number;
}

export type UiBlockStatus = "queued" | "streaming" | "running" | "awaiting-approval" | "completed" | "failed" | "cancelled" | "interrupted" | "unknown" | "not-started" | "denied";
export interface UiDiagnostic { readonly message: string; readonly code?: string }
export interface UiPresentation { readonly kind: string; readonly version: number; readonly text: string }
/** A historical decision is evidence, never an actionable request. */
export interface UiApprovalRecord {
  readonly id: string;
  readonly status: "pending" | "allowed" | "denied" | "cancelled";
  readonly scope?: "once" | "session";
}

export interface UiBlock {
  readonly id: string;
  readonly kind: "user" | "assistant" | "tool" | "notice";
  readonly text: string;
  readonly title?: string;
  readonly status?: UiBlockStatus;
  readonly runId?: string;
  readonly toolCallId?: string;
  readonly approval?: UiApprovalRecord;
  readonly diagnostic?: UiDiagnostic;
  readonly progress?: string;
  readonly reasoning?: string;
  readonly input?: string;
  readonly presentation?: UiPresentation;
}

export interface UiInteraction {
  readonly id: string;
  readonly kind: "approval";
  readonly title: string;
  readonly detail: string;
  /** Links a current host request to its transcript evidence, not an execution command. */
  readonly blockId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly choices: readonly { readonly value: string; readonly label: string }[];
}

export interface UiPanel {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
}

export interface UiChoice {
  readonly command: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export interface UiAction {
  readonly label: string;
  readonly command: string;
  readonly args: Readonly<Record<string, string>>;
  readonly confirm?: string;
  readonly input?: { readonly name: string; readonly label: string; readonly value: string };
}
export interface UiCommandOutput {
  readonly title: string;
  readonly text: string;
  readonly actions?: readonly UiAction[];
}
export interface UiForm {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly mode: "form" | "review" | "url";
  readonly editable: boolean;
  readonly value: string;
  readonly url?: string;
}
export interface UiControls {
  readonly inputCommand: string;
  readonly responseCommand: string;
  readonly cancelCommand: string;
  readonly busy: boolean;
  readonly forms: readonly UiForm[];
}
export interface UiCompletion { readonly value: string; readonly label: string; readonly description?: string }

export interface UiSnapshot {
  readonly version: 1;
  /** New on each host start; prevents replay of an uncertain command after restart. */
  readonly hostId: string;
  readonly revision: number;
  readonly product: UiProduct;
  readonly resources: readonly UiResource[];
  readonly selectedId: string | null;
  /** Workspace execution owner, independent of this client's selected history. Absent for task hosts. */
  readonly activeId?: string;
  readonly blocks: readonly UiBlock[];
  readonly historyPage?: { readonly nextCursor: string | null; readonly total: number };
  readonly reads?: { readonly resources: boolean; readonly history: boolean; readonly fields: boolean };
  readonly interactions: readonly UiInteraction[];
  /** Namespaced, explicitly implemented commands, not arbitrary method names. */
  readonly commands: readonly string[];
  readonly panels: readonly UiPanel[];
  readonly choices: readonly UiChoice[];
  readonly notice?: string;
  readonly controls?: UiControls;
}

export interface UiCommand {
  readonly version: 1;
  readonly hostId: string;
  readonly requestId: string;
  readonly name: string;
  readonly targetId: string | null;
  /** Required for explicit workspace activation/new-session commands. */
  readonly expectedActiveId?: string;
  readonly args: Readonly<Record<string, string>>;
}

export interface UiReceipt { readonly selectedId?: string | null; readonly output?: UiCommandOutput; readonly disconnect?: boolean }

export interface UiPageRequest { readonly query?: string; readonly cursor?: string }
export interface UiPage<T> { readonly hostId: string; readonly items: readonly T[]; readonly nextCursor: string | null; readonly total: number }
export type UiField = "input" | "text" | "reasoning" | "diagnostic" | "presentation";
export interface UiFieldRequest { readonly blockId: string; readonly field: UiField; readonly offset: number; readonly version?: string }
export interface UiFieldPage { readonly hostId: string; readonly text: string; readonly offset: number; readonly nextOffset: number | null; readonly total: number; readonly version: string }

/** One owner consumes runtime events; many clients subscribe to invalidations. */
export interface UiHost {
  readonly hostId: string;
  snapshot(selectedId?: string): Promise<UiSnapshot>;
  execute(command: UiCommand): Promise<UiReceipt>;
  subscribe(listener: () => void): () => void;
  resources?(request: UiPageRequest): Promise<UiPage<UiResource>>;
  history?(selectedId: string, request: UiPageRequest): Promise<UiPage<UiBlock>>;
  field?(selectedId: string, request: UiFieldRequest): Promise<UiFieldPage>;
  complete?(selectedId: string, text: string): Promise<{ readonly hostId: string; readonly items: readonly UiCompletion[] }>;
}

export class UiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "UiError"; }
}

export function commandArgs(command: UiCommand, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !command.args[key]?.trim()) || Object.keys(command.args).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new UiError(400, "命令参数不正确。");
  }
}
