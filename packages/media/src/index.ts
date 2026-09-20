import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContentPart, MediaSource } from "@may/core";
import sharp from "sharp";

export interface ImageAttachment {
  readonly id: string;
  readonly mediaType?: string;
  readonly url?: string;
  readonly fileId?: string;
}
export type DisplayPart = { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly image: ImageAttachment };
export interface ImageData {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
}
export interface SavedImage extends ImageData { readonly id: string; readonly path: string }
export type MediaReader = (source: MediaSource, signal?: AbortSignal) => Promise<ImageData>;
export interface MediaCapabilities {
  readonly images: boolean;
  readonly maxImageBytes: number;
  readonly mediaTypes: readonly string[];
}
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export function imageAttachment(source: MediaSource): ImageAttachment {
  const id = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  if (source.type === "url") {
    const url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Image URL must use HTTP(S) without credentials");
    return { id, url: url.href };
  }
  return source.type === "base64" ? { id, mediaType: source.mediaType } : { id, fileId: source.fileId };
}

export function displayParts(content: readonly ContentPart[]): DisplayPart[] {
  return content.flatMap<DisplayPart>(part => {
    if (part.type === "reasoning") return [];
    if (part.type === "image") return [{ type: "image", image: imageAttachment(part.source) }];
    if (part.type === "text") return [{ type: "text", text: part.text }];
    return [{ type: "text", text: `[${part.type}]` }];
  });
}

export async function inspectImage(data: Uint8Array): Promise<ImageData> {
  if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES) throw new Error("Image size must be between 1 byte and 32 MiB");
  const decoder = sharp(data, { limitInputPixels: 40_000_000, failOn: "error" });
  const metadata = await decoder.metadata();
  const formats: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
  const mediaType = metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : formats[metadata.format ?? ""];
  if (!mediaType || !metadata.width || !metadata.height) throw new Error("Unsupported raster image format");
  await decoder.stats();
  return { data, mediaType, width: metadata.autoOrient.width, height: metadata.autoOrient.height };
}

export const readEmbeddedImage: MediaReader = async source => {
  if (source.type !== "base64") throw new Error(`Image source ${source.type} requires a host-provided MediaReader`);
  if (source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Image exceeds 32 MiB");
  const data = Buffer.from(source.data, "base64");
  if (data.toString("base64") !== source.data) throw new Error("Invalid image base64");
  const image = await inspectImage(data);
  if (image.mediaType !== source.mediaType) throw new Error("Image MIME type does not match its contents");
  return image;
};

export class FileMediaStore {
  constructor(readonly directory: string, readonly read: MediaReader = readEmbeddedImage) {}
  async save(source: MediaSource, signal?: AbortSignal): Promise<SavedImage> {
    const supplied = await this.read(source, signal);
    const image = await inspectImage(supplied.data);
    if (image.mediaType !== supplied.mediaType) throw new Error("MediaReader returned a mismatched MIME type");
    const id = imageAttachment(source).id;
    const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.slice(6);
    const path = join(this.directory, `${id}.${extension}`);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${id}.${randomUUID()}.partial`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(image.data); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    return { ...image, id, path };
  }
  async verify(saved: SavedImage): Promise<ImageData> { return inspectImage(await readFile(saved.path)); }
}

export async function imagePng(image: ImageData): Promise<Buffer> {
  return sharp(image.data, { limitInputPixels: 40_000_000, failOn: "error" }).rotate().png().toBuffer();
}
