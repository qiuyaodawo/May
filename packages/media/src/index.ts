import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { ContentPart, MediaSource } from "@sortedyuan/may/core";
import { withFileAccess } from "@sortedyuan/may/storage";

/** @experimental */
export interface ImageAttachment {
  readonly id: string;
  readonly mediaType?: string;
  readonly url?: string;
  readonly fileId?: string;
}
/** @experimental */
export type DisplayPart =
  { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly image: ImageAttachment };
/** @experimental */
export interface ImageData {
  readonly data: Uint8Array;
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
}
/** @experimental */
export interface SavedImage extends ImageData {
  readonly id: string;
  readonly path: string;
}
/** @experimental */
export type MediaReader = (source: MediaSource, signal?: AbortSignal) => Promise<ImageData>;
/** @experimental */
export interface MediaCapabilities {
  readonly images: boolean;
  readonly maxImageBytes: number;
  readonly mediaTypes: readonly string[];
}
/** @experimental */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** @experimental */
export function imageAttachment(source: MediaSource): ImageAttachment {
  const id = createHash("sha256").update(JSON.stringify(source)).digest("hex");
  if (source.type === "url") {
    const url = new URL(source.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      throw new Error("Image URL must use HTTP(S) without credentials");
    return { id, url: url.href };
  }
  return source.type === "base64" ? { id, mediaType: source.mediaType } : { id, fileId: source.fileId };
}

/** @experimental */
export function displayParts(content: readonly ContentPart[]): DisplayPart[] {
  return content.flatMap<DisplayPart>((part) => {
    if (part.type === "reasoning") return [];
    if (part.type === "image") return [{ type: "image", image: imageAttachment(part.source) }];
    if (part.type === "text") return [{ type: "text", text: part.text }];
    return [{ type: "text", text: `[${part.type}]` }];
  });
}

/** @experimental */
export async function inspectImage(data: Uint8Array): Promise<ImageData> {
  if (!data.byteLength || data.byteLength > MAX_IMAGE_BYTES)
    throw new Error("Image size must be between 1 byte and 32 MiB");
  const { default: sharp } = await import("sharp");
  const decoder = sharp(data, { limitInputPixels: 40_000_000, failOn: "error" });
  const metadata = await decoder.metadata();
  const formats: Record<string, string> = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif",
  };
  const mediaType =
    metadata.format === "heif" && metadata.compression === "av1" ? "image/avif" : formats[metadata.format ?? ""];
  if (!mediaType || !metadata.width || !metadata.height) throw new Error("Unsupported raster image format");
  await decoder.stats();
  return { data, mediaType, width: metadata.autoOrient.width, height: metadata.autoOrient.height };
}

/** @experimental */
export const readEmbeddedImage: MediaReader = async (source) => {
  if (source.type !== "base64") throw new Error(`Image source ${source.type} requires a host-provided MediaReader`);
  if (source.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) throw new Error("Image exceeds 32 MiB");
  const data = Buffer.from(source.data, "base64");
  if (data.toString("base64") !== source.data) throw new Error("Invalid image base64");
  const image = await inspectImage(data);
  if (image.mediaType !== source.mediaType) throw new Error("Image MIME type does not match its contents");
  return image;
};

/** @experimental */
export class FileMediaStore {
  constructor(
    readonly directory: string,
    readonly read: MediaReader = readEmbeddedImage,
  ) {}
  async save(source: MediaSource, signal?: AbortSignal): Promise<SavedImage> {
    const supplied = await this.read(source, signal);
    const image = await inspectImage(supplied.data);
    if (image.mediaType !== supplied.mediaType) throw new Error("MediaReader returned a mismatched MIME type");
    const id = imageAttachment(source).id;
    const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType.slice(6);
    const path = join(this.directory, `${id}.${extension}`);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
    await withFileAccess(path, "exclusive", () => writeFileAtomic(path, data, { mode: 0o600 }));
    return { ...image, id, path };
  }
  async verify(saved: SavedImage): Promise<ImageData> {
    return inspectImage(await withFileAccess(saved.path, "shared", () => readFile(saved.path)));
  }
}

/** @experimental */
export async function imagePng(image: ImageData): Promise<Buffer> {
  const { default: sharp } = await import("sharp");
  return sharp(image.data, { limitInputPixels: 40_000_000, failOn: "error" }).rotate().png().toBuffer();
}
