export function channelTextPages(text: string, limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 64) throw new Error("渠道文字长度限制无效。");
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + limit - 32);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
    chunks.push(text.slice(offset, end)); offset = end;
  }
  return chunks.map((chunk, index) => `[${index + 1}/${chunks.length}]\n${chunk}`);
}
