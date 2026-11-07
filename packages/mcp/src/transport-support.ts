import type { RequestOptions } from "@modelcontextprotocol/client";
import { omitUndefined } from "@sortedyuan/may/core";
import { McpConnectionError, McpToolsListError } from "./errors.js";
import type { McpDiagnostic, McpServerOptions } from "./types.js";

export function requestOptions(options: McpServerOptions, signal?: AbortSignal): RequestOptions {
  return omitUndefined({
    signal,
    timeout: options.requestTimeoutMs,
    maxTotalTimeout: options.maxTotalTimeoutMs,
  });
}

export function toDiagnostic(error: unknown): McpDiagnostic {
  const summary =
    error instanceof McpConnectionError || error instanceof McpToolsListError ? error.summary : errorMessage(error);
  const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const stderr = error instanceof McpConnectionError || error instanceof McpToolsListError ? error.stderr : undefined;
  return omitUndefined({
    name: error instanceof Error ? error.name : "Error",
    message: sanitizeDiagnosticText(summary, 2_000),
    code,
    stderr,
  });
}

export class BoundedStderrBuffer {
  private value = Buffer.alloc(0);

  constructor(private readonly maximumBytes: number) {}

  append(value: unknown): void {
    const incoming = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    if (incoming.length >= this.maximumBytes) {
      this.value = Buffer.from(incoming.subarray(incoming.length - this.maximumBytes));
      return;
    }
    const combined = Buffer.concat([this.value, incoming]);
    this.value =
      combined.length <= this.maximumBytes
        ? combined
        : Buffer.from(combined.subarray(combined.length - this.maximumBytes));
  }

  text(): string | undefined {
    if (this.value.length === 0) return undefined;
    const value = sanitizeDiagnosticText(this.value.toString("utf8"), this.maximumBytes).trim();
    return value === "" ? undefined : value;
  }
}

export function sanitizeDiagnosticText(value: string, maximum: number): string {
  const safe = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "").replace(/\r\n?/gu, "\n");
  return truncate(safe, maximum);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}
