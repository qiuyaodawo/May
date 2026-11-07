import { lookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { MIMEType } from "node:util";
import { defineTool, type Tool } from "@sortedyuan/may/core";
import { convert } from "html-to-text";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { requirePositiveIntegerOption } from "./input.js";

/** @experimental */
export interface FetchToolOptions {
  readonly allowedOrigins?: readonly string[];
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

/** @experimental */
export interface FetchInput {
  readonly url: string;
}

/** @experimental */
export interface FetchOutput {
  readonly url: string;
  readonly contentType: string;
  readonly text: string;
  readonly truncated: boolean;
}

/** @experimental */
export class FetchToolError extends Error {
  constructor(message: string) {
    super(`fetch: ${message}`);
    this.name = "FetchToolError";
  }
}

/** @experimental */
export function createFetchTool(options: FetchToolOptions): Tool<FetchInput, FetchOutput> {
  const maxBytes = requirePositiveIntegerOption(options.maxBytes, 1024 * 1024, "maxBytes");
  const timeoutMs = requirePositiveIntegerOption(options.timeoutMs, 30_000, "timeoutMs");
  const maxRedirects = options.maxRedirects ?? 5;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new RangeError("maxRedirects must be a non-negative safe integer");
  }
  const allowedOrigins = options.allowedOrigins?.map((origin) => {
    const url = parseUrl(origin);
    if (url.origin !== origin) throw new FetchToolError(`allowedOrigins must contain origins: ${origin}`);
    return url.origin;
  });

  return defineTool({
    name: "fetch",
    description:
      "Fetch a public HTTP or HTTPS page and return readable text. Use this for web documentation and pages; it sends no host credentials or cookies.",
    schema: z.object({ url: z.url({ protocol: /^https?$/ }) }).strict(),
    async execute(input, context) {
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]);
      let url = parseUrl(input.url);
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        if (allowedOrigins !== undefined && !allowedOrigins.includes(url.origin)) {
          throw new FetchToolError(`origin is not allowed: ${url.origin}`);
        }
        const hostname = url.hostname.replace(/^\[|\]$/gu, "");
        const address = await resolveAddress(hostname, signal);
        if (allowedOrigins === undefined && ipaddr.process(address).range() !== "unicast") {
          throw new FetchToolError(`address is not public: ${address}`);
        }
        signal.throwIfAborted();
        const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
          signal,
          agent: false,
          family: isIP(address),
          lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
          headers: { accept: "text/html, text/plain, application/json", "accept-encoding": "identity" },
        });
        const closed = new Promise<void>((resolve) => request.once("close", resolve));
        const response = new Promise<IncomingMessage>((resolve, reject) => {
          request.once("response", resolve);
          request.once("error", reject);
        });
        request.end();
        try {
          const incoming = await response;
          const status = incoming.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            if (redirects >= maxRedirects) throw new FetchToolError("redirect limit exceeded");
            const location = incoming.headers.location;
            if (location === undefined) throw new FetchToolError("redirect has no location");
            url = parseUrl(new URL(location, url).href);
            continue;
          }
          if (status < 200 || status >= 300) throw new FetchToolError(`HTTP status ${status}`);
          const contentType = incoming.headers["content-type"] ?? "";
          const mediaType = new MIMEType(contentType).essence;
          if (!(mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json"))) {
            throw new FetchToolError(`unsupported content type: ${contentType}`);
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          let truncated = false;
          for await (const chunk of incoming) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
            const remaining = maxBytes - bytes;
            chunks.push(buffer.subarray(0, remaining));
            bytes += Math.min(buffer.length, remaining);
            if (buffer.length > remaining) {
              truncated = true;
              break;
            }
          }
          const text = Buffer.concat(chunks).toString("utf8");
          return { url: url.href, contentType, text: mediaType === "text/html" ? convert(text) : text, truncated };
        } finally {
          request.destroy();
          await closed;
        }
      }
    },
  });
}

function parseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new FetchToolError("only HTTP and HTTPS are supported");
  if (url.username !== "" || url.password !== "") throw new FetchToolError("URL credentials are not supported");
  return url;
}

function resolveAddress(hostname: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if (isIP(hostname)) return Promise.resolve(hostname);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    lookup(hostname, (error, address) => {
      signal.removeEventListener("abort", abort);
      if (error !== null) reject(error);
      else resolve(address);
    });
  });
}
