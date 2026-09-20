import sharp from "sharp";

export async function imageSource(width = 64, height = 32) {
  const data = await sharp({ create: { width, height, channels: 4, background: { r: 32, g: 120, b: 210, alpha: 1 } } }).png().toBuffer();
  return { type: "base64", mediaType: "image/png", data: data.toString("base64") };
}
