import type {
  CodingExecutionEnvironment,
  WorkspaceDiagnostic,
  WorkspaceFileFeedback,
  WorkspaceFileGuard,
  WorkspaceFileFeedbackResult,
  WorkspacePath,
  ToolChangePreview,
} from "@sortedyuan/coding-tools";
import type { TextEdit } from "vscode-languageserver-protocol";

/** @experimental */
export interface LanguageServerDefinition {
  readonly id: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly languages?: Readonly<Record<string, readonly string[]>>;
  readonly initializationOptions?: unknown;
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}
/** @experimental */
export interface LanguageServerManagerOptions {
  readonly execution: CodingExecutionEnvironment;
  readonly servers: readonly LanguageServerDefinition[];
  readonly dataDirectory: string;
  readonly guard?: WorkspaceFileGuard;
  readonly startTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly diagnosticsTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxFileBytes?: number;
  readonly maxResults?: number;
  readonly maxHoverChars?: number;
  readonly maxEditDiagnostics?: number;
  readonly maxDiagnostics?: number;
  readonly maxServers?: number;
  readonly diagnosticSeverities?: readonly WorkspaceDiagnostic["severity"][];
}
/** @experimental */
export type SymbolPosition = { readonly path: string; readonly line: number } & (
  | { readonly symbol: string; readonly occurrence?: number; readonly column?: never }
  | { readonly column: number; readonly symbol?: never; readonly occurrence?: never }
);
/** @experimental */
export type LspLocation =
  | {
      readonly path: string;
      readonly line: number;
      readonly column: number;
      readonly endLine: number;
      readonly endColumn: number;
      readonly preview: string;
    }
  | { readonly outsideWorkspace: true; readonly environmentPath: string };
/** @experimental */
export interface ServerBusy {
  readonly titles: readonly string[];
}
/** @experimental */
export interface LocationList {
  readonly locations: readonly LspLocation[];
  readonly truncated: boolean;
  readonly serverBusy?: ServerBusy;
}
/** @experimental */
export interface HoverText {
  readonly text: string;
  readonly truncated: boolean;
  readonly serverBusy?: ServerBusy;
}
/** @experimental */
export interface LspSymbol {
  readonly name: string;
  readonly kind: number;
  readonly location: LspLocation;
  readonly containerName?: string;
}
/** @experimental */
export interface SymbolList {
  readonly symbols: readonly LspSymbol[];
  readonly truncated: boolean;
  readonly serverBusy?: ServerBusy;
}
/** @experimental */
export type FileDiagnostics = WorkspaceFileFeedbackResult["diagnostics"] & { readonly serverBusy?: ServerBusy };
/** @experimental */
export interface LanguageServerStatus {
  readonly id: string;
  readonly languages: Readonly<Record<string, readonly string[]>>;
  readonly state: "stopped" | "starting" | "running" | "failed";
  readonly command?: string;
  readonly args?: readonly string[];
  readonly pid?: number;
  readonly progress: readonly string[];
  readonly lastError?: string;
  readonly stderr: string;
  readonly logs: string;
  readonly recovery?: string;
}
/** @experimental */
export interface RenameFile {
  readonly path: WorkspacePath;
  readonly original: string;
  readonly updated: string;
  readonly originalHash: string;
  readonly updatedHash: string;
  readonly edits: readonly TextEdit[];
}
/** @experimental */
export interface RenamePlan {
  readonly files: readonly RenameFile[];
  readonly newName: string;
}
/** @experimental */
export interface RenameOutput {
  readonly files: readonly { readonly path: string; readonly edits: number }[];
  readonly diagnostics: Readonly<Record<string, FileDiagnostics>>;
}
/** @experimental */
export interface RenamePreview {
  readonly kind: "maybecode.lsp-rename-preview";
  readonly files: readonly ToolChangePreview[];
}
/** @experimental */
export interface LanguageServerManager {
  status(): readonly LanguageServerStatus[];
  diagnostics(path: string, signal: AbortSignal): Promise<FileDiagnostics>;
  definition(position: SymbolPosition, signal: AbortSignal): Promise<readonly LspLocation[]>;
  references(position: SymbolPosition, includeDeclaration: boolean, signal: AbortSignal): Promise<LocationList>;
  hover(position: SymbolPosition, signal: AbortSignal): Promise<HoverText>;
  documentSymbols(path: string, signal: AbortSignal): Promise<SymbolList>;
  workspaceSymbols(language: string, query: string, signal: AbortSignal): Promise<SymbolList>;
  planRename(position: SymbolPosition, newName: string, signal: AbortSignal): Promise<RenamePlan>;
  executeRename(plan: RenamePlan, signal: AbortSignal, guard?: WorkspaceFileGuard): Promise<RenameOutput>;
  cacheRename(toolCallId: string, input: SymbolPosition & { readonly newName: string }, plan: RenamePlan): void;
  takeRename(toolCallId: string, input: SymbolPosition & { readonly newName: string }): RenamePlan | undefined;
  readonly fileFeedback: WorkspaceFileFeedback;
  restart(serverId: string): Promise<void>;
  close(): Promise<void>;
}
