export function formatCliError(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/\b(api[-_]?key|password|secret|access[-_]?token|authorization|credentials|refresh[-_]?token)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[redacted]");
  for (const [key, value] of Object.entries(process.env)) {
    if (/(TOKEN|SECRET|PASSWORD|API_?KEY|AUTHORIZATION)/i.test(key) && value !== undefined && value.length >= 4) {
      message = message.replaceAll(value, "[redacted]");
    }
  }
  return message.slice(0, 4096);
}
