import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";

export async function listenForCallback(state: string, port: number, signal: AbortSignal) {
  signal.throwIfAborted();
  let complete!: (params: URLSearchParams) => void;
  let fail!: (reason: unknown) => void;
  const result = new Promise<PromiseSettledResult<URLSearchParams>>((resolve) => {
    complete = (value) => resolve({ status: "fulfilled", value });
    fail = (reason) => resolve({ status: "rejected", reason });
  });
  let closing: Promise<void> | undefined;
  let url = "";
  let consumed = false;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    if (consumed || request.method !== "GET" || (request.url?.length ?? 0) > 8192) {
      response.writeHead(400).end();
      return;
    }
    let target: URL;
    try {
      target = new URL(request.url ?? "/", url);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (
      request.headers.host !== new URL(url).host ||
      target.origin !== new URL(url).origin ||
      target.pathname !== "/oauth/callback"
    ) {
      response.writeHead(404).end();
      return;
    }
    const actual = Buffer.from(target.searchParams.get("state") ?? "");
    if (
      ["state", "code", "iss", "error"].some((key) => target.searchParams.getAll(key).length > 1) ||
      actual.length !== Buffer.byteLength(state) ||
      !timingSafeEqual(actual, Buffer.from(state))
    ) {
      response.writeHead(400).end("Invalid authorization callback.");
      return;
    }
    consumed = true;
    response.end("Authorization callback received. Return to May to check the result.");
    complete(target.searchParams);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Callback listener unavailable");
  url = `http://127.0.0.1:${address.port}/oauth/callback`;
  const abort = () => {
    fail(signal.reason);
    closing ??= closeServer(server);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return {
    url,
    result,
    close: async () => {
      signal.removeEventListener("abort", abort);
      await (closing ??= closeServer(server));
    },
  };
}
async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}
