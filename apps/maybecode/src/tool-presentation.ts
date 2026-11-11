import type { AgentToolPresentation } from "@sortedyuan/may";
import type { PermissionCheck } from "@sortedyuan/may/permissions";
import {
  createToolChangePreview,
  TOOL_CHANGE_PREVIEW_PRESENTATION_KIND,
  TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION,
} from "@sortedyuan/coding-tools";
import { createRenamePreview, type LanguageServerManager } from "@sortedyuan/lsp-tools";

export async function createMaybeCodeToolPresentation(
  workspace: string,
  manager: LanguageServerManager | undefined,
  check: PermissionCheck,
): Promise<AgentToolPresentation | undefined> {
  if (check.tool.name === "lsp_rename" && manager) {
    const preview = await createRenamePreview(manager, check.input, check.context.toolCallId, check.context.signal);
    return { kind: preview.kind, version: 1, data: preview };
  }
  const preview = await createToolChangePreview(workspace, check.tool.name, check.input);
  return preview === undefined
    ? undefined
    : { kind: TOOL_CHANGE_PREVIEW_PRESENTATION_KIND, version: TOOL_CHANGE_PREVIEW_PRESENTATION_VERSION, data: preview };
}
