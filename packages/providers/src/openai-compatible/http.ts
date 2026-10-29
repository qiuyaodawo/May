import { createParser } from "eventsource-parser";

export async function* readSseData(
  response: Response,
  signal: AbortSignal,
  protocolError: (message: string, options?: ErrorOptions) => Error,
  providerName: string,
): AsyncGenerator<string> {
  if (!response.body) {
    throw protocolError(`${providerName} response has no body`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const dataEvents: string[] = [];
  const parser = createParser({
    onEvent: (event) => dataEvents.push(event.data),
  });
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        // 流结束时补全事件终止符，以支持没有空白行的最后一个事件。
        parser.feed(`${decoder.decode()}\n\n`);
      } else {
        parser.feed(decoder.decode(value, { stream: true }));
      }
      for (const data of dataEvents) {
        throwIfAborted(signal);
        yield data;
      }
      dataEvents.length = 0;
      if (done) break;
    }

    throwIfAborted(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}
