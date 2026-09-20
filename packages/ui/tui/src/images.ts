import { homedir } from "node:os";
import { join } from "node:path";
import type { ContentPart, MediaSource } from "@may/core";
import { FileMediaStore, imageAttachment, imagePng, readEmbeddedImage, type SavedImage } from "@may/media";
import { Jimp } from "jimp";
import { FINALIZER, introducer, sixelEncode } from "sixel";
import { applyPaletteSync, buildPaletteSync, utils } from "image-q";
import { terminalImageProtocol, type ImageProtocol, type TerminalCellSize } from "./image-support.js";
import type { Component, ImagePlacement, RenderResult, RenderSize } from "./component.js";
import { Text, sanitizeTerminalText } from "./text.js";

export { terminalImageProtocol, type ImageProtocol } from "./image-support.js";

export interface TerminalImagesOptions {
  readonly cellSize?: () => TerminalCellSize | undefined;
}

type PreparedImage = SavedImage & { png: string; raster?: Awaited<ReturnType<typeof Jimp.read>>; frame?: { key: string; sixel: string } };

export class TerminalImages {
  private readonly values = new Map<string, PreparedImage>();
  private version = 0;
  constructor(readonly store = new FileMediaStore(join(homedir(), ".may", "media")), readonly protocol: ImageProtocol = terminalImageProtocol(), private readonly options: TerminalImagesOptions = {}) {}
  get revision(): string {
    const cell = this.options.cellSize?.();
    return `${this.version}:${cell?.width}:${cell?.height}`;
  }
  async prepare(content: readonly ContentPart[]): Promise<void> {
    for (const part of content) if (part.type === "image" && (part.source.type === "base64" || this.store.read !== readEmbeddedImage)) {
      const id = imageAttachment(part.source).id;
      if (this.values.has(id)) continue;
      const image = await this.store.save(part.source);
      const png = this.protocol === "none" ? Buffer.alloc(0) : await imagePng(image);
      const raster = this.protocol === "sixel" ? await Jimp.read(png) : undefined;
      if (raster && (raster.width > 1280 || raster.height > 768)) raster.scaleToFit({ w: 1280, h: 768 });
      this.values.set(id, { ...image, png: png.toString("base64"), ...(raster ? { raster } : {}) });
      this.version++;
    }
  }
  component(source: MediaSource): Component { return { render: size => this.render(source, size) }; }
  render(source: MediaSource, size: RenderSize): RenderResult {
    const attachment = imageAttachment(source), image = this.values.get(attachment.id);
    const caption = image ? `图片 ${image.width}×${image.height} · ${image.mediaType} · ${image.data.byteLength} bytes\n${image.path}`
      : attachment.url ? `图片链接：${attachment.url}` : `图片 ${attachment.id}（媒体读取接口未提供此资源）`;
    const label = new Text(sanitizeTerminalText(caption)).render(size);
    if (!image || this.protocol === "none") return label;
    if (this.protocol === "sixel") return this.renderSixel(image, label, size);
    const columns = Math.max(1, Math.min(size.width, 80));
    const rows = Math.max(1, Math.min(12, Math.ceil(columns * image.height / image.width / 2)));
    if (rows + label.lines.length > size.height) return label;
    const width = Math.max(1, Math.min(columns, Math.round(rows * 2 * image.width / image.height)));
    return { lines: [...label.lines, ...Array.from({ length: rows }, () => "")], images: [{ id: image.id, png: image.png, protocol: this.protocol, x: 0, y: label.lines.length, columns: width, rows }] };
  }

  private renderSixel(image: PreparedImage, label: RenderResult, size: RenderSize): RenderResult {
    const cell = this.options.cellSize?.();
    if (!cell) return label;
    if (![cell.width, cell.height].every(value => Number.isInteger(value) && value > 0)) throw new RangeError("Terminal cell dimensions must be positive integers");
    const raster = image.raster;
    if (!raster) throw new Error("Sixel image was not prepared");
    const maxWidth = Math.min(1280, Math.min(80, size.width) * cell.width);
    const maxHeight = Math.floor(Math.min(768, 12 * cell.height) / 6) * 6;
    const scale = Math.min(1, maxWidth / raster.width, maxHeight / raster.height);
    const width = Math.max(1, Math.floor(raster.width * scale));
    const height = Math.max(1, Math.floor(raster.height * scale));
    const rows = Math.ceil(Math.ceil(height / 6) * 6 / cell.height);
    if (rows + label.lines.length > size.height) return label;
    const key = `${width}:${height}`;
    if (image.frame?.key !== key) {
      const resized = raster.clone().resize({ w: width, h: height });
      const bitmap = new Jimp({ width, height, color: 0xffffffff }).composite(resized, 0, 0).bitmap;
      const pixels = utils.PointContainer.fromUint8Array(new Uint8Array(bitmap.data), width, height);
      const palette = buildPaletteSync([pixels], { colors: 256, paletteQuantization: "wuquant", colorDistanceFormula: "euclidean" });
      const quantized = applyPaletteSync(pixels, palette, { imageQuantization: "floyd-steinberg", colorDistanceFormula: "euclidean" });
      const data = new Uint8Array(quantized.toUint8Array());
      image.frame = { key, sixel: introducer(1) + sixelEncode(data, width, height, Array.from(palette.getPointContainer().toUint32Array())) + FINALIZER };
    }
    return {
      lines: [...label.lines, ...Array.from({ length: rows }, () => "")],
      images: [{ id: image.id, png: image.png, protocol: "sixel", sixel: image.frame.sixel, x: 0, y: label.lines.length, columns: Math.ceil(width / cell.width), rows }],
    };
  }
}

export function encodeImage(image: ImagePlacement): string {
  if (image.protocol === "sixel") return `\x1b[?80;8452s\x1b[?80l\x1b[?8452h${image.sixel}\x1b[?80;8452r`;
  if (image.protocol === "iterm2") return `\x1b]1337;File=inline=1;width=${image.columns};height=${image.rows};preserveAspectRatio=1:${image.png}\x07`;
  const chunks: string[] = [];
  for (let offset = 0; offset < image.png.length; offset += 4096) {
    const last = offset + 4096 >= image.png.length;
    chunks.push(`\x1b_G${offset === 0 ? `a=T,f=100,q=2,C=1,c=${image.columns},r=${image.rows},` : "q=2,"}m=${last ? 0 : 1};${image.png.slice(offset, offset + 4096)}\x1b\\`);
  }
  return chunks.join("");
}
