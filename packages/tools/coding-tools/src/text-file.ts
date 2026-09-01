import { readFile, stat } from "node:fs/promises";
import { CodingToolError } from "./errors.js";

// Keep a leading BOM so edit can round-trip bytes outside the replacement.
const UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export async function readTextFile(
  path: string,
  displayPath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const information = await stat(path);
  if (!information.isFile()) {
    throw new CodingToolError(
      "CODING_TOOL_NOT_A_FILE",
      `Path is not a file: ${displayPath}`,
    );
  }
  if (information.size > maxBytes) {
    throw fileTooLarge(displayPath, information.size, maxBytes);
  }

  const contents = await readFile(path, { signal });
  if (contents.byteLength > maxBytes) {
    throw fileTooLarge(displayPath, contents.byteLength, maxBytes);
  }
  try {
    return UTF8_DECODER.decode(contents);
  } catch (error) {
    throw new CodingToolError(
      "CODING_TOOL_NOT_TEXT",
      `File is not valid UTF-8 text: ${displayPath}`,
      { cause: error },
    );
  }
}

export function assertTextWithinLimit(
  text: string,
  displayPath: string,
  maxBytes: number,
): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes) throw fileTooLarge(displayPath, bytes, maxBytes);
  return bytes;
}

function fileTooLarge(
  path: string,
  actualBytes: number,
  maxBytes: number,
): CodingToolError {
  return new CodingToolError(
    "CODING_TOOL_FILE_TOO_LARGE",
    `File exceeds the ${maxBytes} byte limit: ${path} (${actualBytes} bytes)`,
  );
}
