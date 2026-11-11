import type { AssistantMessage, ContentPart } from "@sortedyuan/may/core";

export function assistantDisplayContent(message: AssistantMessage): readonly ContentPart[] {
  const sources = new Map<string, string>();
  for (const part of message.content)
    if (part.type === "text")
      for (const citation of part.citations ?? []) sources.set(citation.url, citation.title ?? citation.url);
  for (const call of message.serverToolCalls ?? [])
    for (const source of call.sources ?? []) sources.set(source.url, source.title ?? source.url);
  return sources.size
    ? [
        ...message.content,
        { type: "text", text: `\n\nSources:\n${[...sources].map(([url, title]) => `${title} · ${url}`).join("\n")}` },
      ]
    : message.content;
}

export function lspRenamePreviewText(data: unknown): string {
  if (!data || typeof data !== "object" || !("files" in data) || !Array.isArray(data.files))
    throw new TypeError("Invalid LSP rename preview");
  return data.files
    .map((file: unknown) => {
      if (!file || typeof file !== "object" || !("path" in file) || typeof file.path !== "string")
        throw new TypeError("Invalid LSP rename file preview");
      if ("diff" in file && typeof file.diff === "string") return `${file.path}\n${file.diff}`;
      if ("reason" in file && typeof file.reason === "string") return `${file.path}\n${file.reason}`;
      throw new TypeError("LSP rename file preview requires diff or reason");
    })
    .join("\n\n");
}
