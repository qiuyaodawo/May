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

export interface UiBlock {
  readonly id: string;
  readonly kind: "user" | "assistant" | "tool" | "notice";
  readonly text: string;
  readonly title?: string;
  readonly status?: string;
  readonly reasoning?: string;
  readonly input?: string;
  readonly presentation?: { readonly kind: string; readonly version: number; readonly text: string };
}

export interface UiInteraction {
  readonly id: string;
  readonly kind: "approval";
  readonly title: string;
  readonly detail: string;
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
  readonly interactions: readonly UiInteraction[];
  /** Namespaced, explicitly implemented commands, not arbitrary method names. */
  readonly commands: readonly string[];
  readonly panels: readonly UiPanel[];
  readonly choices: readonly UiChoice[];
  readonly notice?: string;
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

export interface UiReceipt { readonly selectedId?: string | null }

/** One owner consumes runtime events; many clients subscribe to invalidations. */
export interface UiHost {
  readonly hostId: string;
  snapshot(selectedId?: string): Promise<UiSnapshot>;
  execute(command: UiCommand): Promise<UiReceipt>;
  subscribe(listener: () => void): () => void;
}

export class UiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "UiError"; }
}

export function commandArgs(command: UiCommand, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !command.args[key]?.trim()) || Object.keys(command.args).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new UiError(400, "命令参数不正确。");
  }
}
