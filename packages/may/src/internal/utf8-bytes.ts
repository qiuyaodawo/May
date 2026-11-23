export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
