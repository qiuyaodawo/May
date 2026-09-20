import { Jimp } from "jimp";

export async function multicolorImage(width = 61, height = 37) {
  const palette = [0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffff00ff, 0xff00ffff, 0x00ffffff, 0xffffffff, 0x000000ff];
  const image = new Jimp({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) image.setPixelColor(palette[(Math.floor(x / 3) + Math.floor(y / 2) * 3) % palette.length], x, y);
  }
  const pixels = Buffer.from(image.bitmap.data);
  const png = await image.getBuffer("image/png");
  return { width, height, pixels, source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } };
}
