import { createHash } from "node:crypto";

export const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export function tail(text: string): string {
  return Buffer.from(text).subarray(-65536).toString("utf8");
}
