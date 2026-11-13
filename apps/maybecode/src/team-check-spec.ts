import { isAbsolute } from "node:path";

export type TeamCheckSpec =
  | {
      readonly id: string;
      readonly taskId: string;
      readonly type: "file-contains";
      readonly path: string;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly taskId: string;
      readonly type: "file-sha256";
      readonly path: string;
      readonly sha256: string;
    }
  | {
      readonly id: string;
      readonly taskId: string;
      readonly type: "command";
      readonly command: string;
      readonly args: readonly string[];
      readonly timeoutMs?: number;
      readonly maxOutputBytes?: number;
    };

export interface TeamEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly quote?: string;
}
export interface TeamReport {
  readonly summary: string;
  readonly claims: readonly {
    readonly text: string;
    readonly kind: "finding" | "proposal";
    readonly evidence?: readonly TeamEvidence[];
  }[];
}

export function parseTeamCheck(value: unknown): TeamCheckSpec {
  const raw = fields(value, [
    "id",
    "taskId",
    "type",
    "path",
    "text",
    "sha256",
    "command",
    "args",
    "timeoutMs",
    "maxOutputBytes",
  ]);
  identifier(raw.id, "check id");
  identifier(raw.taskId, "check taskId");
  if (raw.type === "file-contains") {
    fields(raw, ["id", "taskId", "type", "path", "text"]);
    safeRelative(raw.path);
    boundedString(raw.text, "check text", 65536);
  } else if (raw.type === "file-sha256") {
    fields(raw, ["id", "taskId", "type", "path", "sha256"]);
    safeRelative(raw.path);
    if (typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(raw.sha256)) throw new Error("Invalid SHA-256");
  } else if (raw.type === "command") {
    fields(raw, ["id", "taskId", "type", "command", "args", "timeoutMs", "maxOutputBytes"]);
    boundedString(raw.command, "check command", 4096);
    if (
      /[\u0000\r\n]/u.test(raw.command as string) ||
      !Array.isArray(raw.args) ||
      raw.args.length > 64 ||
      raw.args.some((arg) => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))
    )
      throw new Error("Invalid check command arguments");
    if (raw.timeoutMs !== undefined) integer(raw.timeoutMs, 1, 120000, "check timeoutMs");
    if (raw.maxOutputBytes !== undefined) integer(raw.maxOutputBytes, 1, 1048576, "check maxOutputBytes");
  } else throw new Error("Unknown check type");
  return structuredClone(raw) as unknown as TeamCheckSpec;
}

export function parseTeamChecks(value: unknown): readonly TeamCheckSpec[] {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Checks must be an array of at most 128 entries");
  const checks = value.map(parseTeamCheck);
  if (new Set(checks.map((entry) => entry.id)).size !== checks.length) throw new Error("Check ids must be unique");
  return checks;
}

export function parseTeamReport(value: unknown): TeamReport {
  const report = fields(value, ["summary", "claims"]);
  boundedString(report.summary, "report summary", 8192);
  if (!Array.isArray(report.claims) || report.claims.length > 64)
    throw new Error("Report claims must be an array of at most 64 entries");
  for (const value of report.claims) {
    const claim = fields(value, ["text", "kind", "evidence"]);
    boundedString(claim.text, "claim text", 4096);
    if (claim.kind !== "finding" && claim.kind !== "proposal") throw new Error("Invalid report claim kind");
    if (claim.evidence !== undefined) {
      if (!Array.isArray(claim.evidence) || claim.evidence.length > 16) throw new Error("Too many evidence references");
      for (const item of claim.evidence) {
        const evidence = fields(item, ["path", "startLine", "endLine", "quote"]);
        safeRelative(evidence.path);
        integer(evidence.startLine, 1, 1000000, "evidence startLine");
        integer(evidence.endLine, evidence.startLine as number, 1000000, "evidence endLine");
        if ((evidence.endLine as number) - (evidence.startLine as number) > 1000)
          throw new Error("Evidence range exceeds 1001 lines");
        if (evidence.quote !== undefined) boundedString(evidence.quote, "evidence quote", 8192);
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(report)) > 65536) throw new Error("Report exceeds 64 KiB");
  return structuredClone(report) as unknown as TeamReport;
}

export function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !allowed.includes(key))
  )
    throw new Error("Invalid verification fields");
  return value as Record<string, unknown>;
}
export function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/u.test(value))
    throw new Error(`Invalid ${label}`);
}
export function boundedString(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > max || value.includes("\0"))
    throw new Error(`Invalid ${label}`);
}
export function integer(value: unknown, min: number, max: number, label: string): void {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max)
    throw new Error(`Invalid ${label}`);
}
export function safeRelative(value: unknown): asserts value is string {
  boundedString(value, "workspace relative path", 2048);
  if (
    isAbsolute(value) ||
    /[:\u0000-\u001f]/u.test(value) ||
    value
      .replace(/\\/gu, "/")
      .split("/")
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Unsafe workspace relative path");
}
