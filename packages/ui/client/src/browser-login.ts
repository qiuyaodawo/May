import { randomBytes } from "node:crypto";
import { UiError } from "./protocol.js";

export class BrowserLogin {
  private readonly tickets = new Map<string, number>();

  constructor(private readonly token: string, private readonly lifetimeMs = 60_000) {
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs <= 0) throw new Error("连接凭据有效期必须为正整数。");
  }

  issue(): string {
    const now = Date.now();
    for (const [ticket, expiresAt] of this.tickets) if (expiresAt <= now) this.tickets.delete(ticket);
    if (this.tickets.size >= 8) throw new UiError(429, "待连接页面过多，请稍后重新打开。");
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(ticket, now + this.lifetimeMs);
    return ticket;
  }

  redeem(ticket: unknown): string {
    if (typeof ticket !== "string") throw new UiError(401, "连接凭据无效。");
    const expiresAt = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (expiresAt === undefined || expiresAt <= Date.now()) throw new UiError(401, "连接已失效，请从启动程序重新打开页面。");
    return this.token;
  }

  clear(): void { this.tickets.clear(); }
}
