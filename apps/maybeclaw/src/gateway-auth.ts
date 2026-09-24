import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Algorithm, Version, hash, parseOptions, verify } from "@node-rs/argon2";
import { UiError } from "@may/ui-client";
import { withGatewayConfiguration } from "./gateway-config.js";

const parameters = { algorithm: Algorithm.Argon2id, version: Version.V0x13, memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 };
export async function hashAdministratorPassword(password: unknown): Promise<string> {
  const settings = authSettings({ password });
  return hash(settings.password!, parameters);
}
interface Login { expiresAt: number; responses: Set<ServerResponse>; timer: NodeJS.Timeout }

export function authSettings(value: unknown): { password?: string; passwordHash?: string; sessionMs: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请配置 apps.maybeclaw.server.auth.password。");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => !["password", "passwordHash", "sessionMs"].includes(key))) throw new Error("server.auth 包含未知字段。");
  if (raw.password !== undefined && (typeof raw.password !== "string" || raw.password.length < 10 || raw.password.length > 1024)) throw new Error("管理员密码需要包含 10 至 1024 个字符。");
  if (raw.password === undefined) {
    if (typeof raw.passwordHash !== "string" || raw.passwordHash.length > 512) throw new Error("请配置 apps.maybeclaw.server.auth.password。");
    try {
      const parsed = parseOptions(raw.passwordHash);
      if (Object.entries(parameters).some(([key, value]) => parsed[key as keyof typeof parsed] !== value) || parsed.saltLen < 16) throw new Error();
    } catch { throw new Error("server.auth.passwordHash 无效，请填写 password 重新生成。"); }
  }
  const sessionMs = raw.sessionMs ?? 8 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(sessionMs) || (sessionMs as number) < 1000 || (sessionMs as number) > 86_400_000) throw new Error("server.auth.sessionMs 需要为 1000 至 86400000 的整数。");
  return { ...(raw.password === undefined ? {} : { password: raw.password as string }), ...(raw.passwordHash === undefined ? {} : { passwordHash: raw.passwordHash as string }), sessionMs: sessionMs as number };
}

export class GatewayAuth {
  private passwordHash = "";
  private sessionMs = 0;
  private readonly sessions = new Map<string, Login>();
  private refreshWork: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  private attempts: number[] = [];
  private verifying = 0;
  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<GatewayAuth> {
    const auth = new GatewayAuth(path);
    await auth.refresh();
    auth.timer = setInterval(() => { void auth.refresh().catch(() => { /* 配置错误已清除登录，后续请求会报告错误。 */ }); }, 500);
    auth.timer.unref();
    return auth;
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.reject(new UiError(503, "认证服务已关闭。"));
    return this.refreshWork ??= withGatewayConfiguration(this.path, async (raw, save) => {
      const settings = authSettings(raw.server?.auth);
      if (settings.password !== undefined || settings.passwordHash !== this.passwordHash || settings.sessionMs !== this.sessionMs) {
        this.clear(); this.passwordHash = "";
        const encoded = settings.password === undefined ? settings.passwordHash! : await hash(settings.password, parameters);
        if (settings.password !== undefined) {
          raw.server.auth = { passwordHash: encoded, ...(raw.server.auth.sessionMs === undefined ? {} : { sessionMs: settings.sessionMs }) };
          await save();
        }
        this.passwordHash = encoded; this.sessionMs = settings.sessionMs;
      }
    }).catch(() => {
      this.clear(); this.passwordHash = "";
      throw new UiError(503, "管理员认证配置不可用，请检查 server.auth 和配置文件的读写权限。");
    }).finally(() => { this.refreshWork = undefined; });
  }
  async login(password: unknown): Promise<{ token: string; expiresAt: number }> {
    await this.refresh();
    if (typeof password !== "string" || password.length < 10 || password.length > 1024) throw new UiError(401, "管理员密码错误。");
    const now = Date.now(); this.attempts = this.attempts.filter(time => now - time < 60_000);
    if (this.attempts.length >= 10 || this.verifying >= 2) throw new UiError(429, "登录尝试过于频繁，请稍后重试。");
    this.attempts.push(now); this.verifying++;
    const encoded = this.passwordHash;
    try {
      const accepted = await verify(encoded, password);
      await this.refresh();
      if (!accepted || encoded !== this.passwordHash) throw new UiError(401, "管理员密码错误或已经修改。");
      this.attempts = [];
      if (this.sessions.size >= 128) throw new UiError(429, "登录数量达到限制，请退出已有登录。");
      const token = randomBytes(32).toString("base64url"), key = digest(token), expiresAt = Date.now() + this.sessionMs;
      const timer = setTimeout(() => this.revoke(key), this.sessionMs); timer.unref();
      this.sessions.set(key, { expiresAt, responses: new Set(), timer });
      return { token, expiresAt };
    } finally { this.verifying--; }
  }
  authorize(req: IncomingMessage): string | undefined {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ") || header.length > 256) return;
    const key = digest(header.slice(7)), session = this.sessions.get(key);
    if (!session) return;
    if (session.expiresAt <= Date.now()) { this.revoke(key); return; }
    return key;
  }
  track(key: string, res: ServerResponse): void {
    const session = this.sessions.get(key);
    if (!session) { res.destroy(); return; }
    session.responses.add(res);
    res.once("close", () => session.responses.delete(res));
  }
  revoke(key: string): void {
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key); clearTimeout(session.timer);
    for (const res of session.responses) res.end();
  }
  private clear(): void { for (const key of this.sessions.keys()) this.revoke(key); }
  async close(): Promise<void> {
    this.closed = true; clearInterval(this.timer); this.clear();
    await this.refreshWork?.catch(() => {});
    this.passwordHash = "";
  }
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
