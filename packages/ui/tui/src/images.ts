import { homedir } from "node:os";
import { join } from "node:path";
import type { ContentPart, MediaSource } from "@may/core";
import { FileMediaStore, imageAttachment, imagePng, readEmbeddedImage, type SavedImage } from "@may/media";
import graphics from "supports-terminal-graphics";
import type { Component, ImagePlacement, RenderResult, RenderSize } from "./component.js";
import { Text, sanitizeTerminalText } from "./text.js";

export type ImageProtocol = "kitty" | "iterm2" | "none";
export function terminalImageProtocol(): ImageProtocol {
  const setting = process.env.MAY_IMAGE_PROTOCOL;
  if (setting !== undefined && !["auto", "kitty", "iterm2", "none"].includes(setting)) throw new Error("MAY_IMAGE_PROTOCOL must be auto, kitty, iterm2 or none");
  if (setting && setting !== "auto") return setting as ImageProtocol;
  if (!process.stdout.isTTY || process.env.TMUX || process.env.STY) return "none";
  return graphics.stdout.iterm2 ? "iterm2" : graphics.stdout.kitty ? "kitty" : "none";
}

export class TerminalImages {
  private readonly values = new Map<string, SavedImage & { png: string }>();
  constructor(readonly store = new FileMediaStore(join(homedir(), ".may", "media")), readonly protocol: ImageProtocol = terminalImageProtocol()) {}
  async prepare(content: readonly ContentPart[]): Promise<void> {
    for (const part of content) if (part.type === "image" && (part.source.type === "base64" || this.store.read !== readEmbeddedImage)) {
      const id = imageAttachment(part.source).id;
      if (this.values.has(id)) continue;
      const image = await this.store.save(part.source);
      this.values.set(id, { ...image, png: this.protocol === "none" ? "" : (await imagePng(image)).toString("base64") });
    }
  }
  component(source: MediaSource): Component { return { render: size => this.render(source, size) }; }
  render(source: MediaSource, size: RenderSize): RenderResult {
    const attachment = imageAttachment(source), image = this.values.get(attachment.id);
    const caption = image ? `图片 ${image.width}×${image.height} · ${image.mediaType} · ${image.data.byteLength} bytes\n${image.path}`
      : attachment.url ? `图片链接：${attachment.url}` : `图片 ${attachment.id}（媒体读取接口未提供此资源）`;
    const label = new Text(sanitizeTerminalText(caption)).render(size);
    if (!image || this.protocol === "none") return label;
    const columns = Math.max(1, Math.min(size.width, 80));
    const rows = Math.max(1, Math.min(12, Math.ceil(columns * image.height / image.width / 2)));
    if (rows + label.lines.length > size.height) return label;
    const width = Math.max(1, Math.min(columns, Math.round(rows * 2 * image.width / image.height)));
    return { lines: [...label.lines, ...Array.from({ length: rows }, () => "")], images: [{ id: image.id, png: image.png, protocol: this.protocol, x: 0, y: label.lines.length, columns: width, rows }] };
  }
}

export function encodeImage(image: ImagePlacement): string {
  if (image.protocol === "iterm2") return `\x1b]1337;File=inline=1;width=${image.columns};height=${image.rows};preserveAspectRatio=1:${image.png}\x07`;
  const chunks: string[] = [];
  for (let offset = 0; offset < image.png.length; offset += 4096) {
    const last = offset + 4096 >= image.png.length;
    chunks.push(`\x1b_G${offset === 0 ? `a=T,f=100,q=2,C=1,c=${image.columns},r=${image.rows},` : "q=2,"}m=${last ? 0 : 1};${image.png.slice(offset, offset + 4096)}\x1b\\`);
  }
  return chunks.join("");
}
