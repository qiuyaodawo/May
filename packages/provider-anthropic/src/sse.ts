import { AnthropicProtocolError } from "./errors.js";

export async function* readAnthropicSseData(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) {
    throw new AnthropicProtocolError("Anthropic response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parsed = drainEvents(buffer);
      buffer = parsed.remainder;
      for (const data of parsed.data) yield data;
    }

    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const data = parseEvent(buffer);
      if (data !== undefined) yield data;
    }

    throwIfAborted(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function drainEvents(input: string): { data: string[]; remainder: string } {
  const data: string[] = [];
  let remainder = input;

  while (true) {
    const separator = /\r?\n\r?\n/.exec(remainder);
    if (!separator || separator.index === undefined) break;

    const block = remainder.slice(0, separator.index);
    remainder = remainder.slice(separator.index + separator[0].length);
    const parsed = parseEvent(block);
    if (parsed !== undefined) data.push(parsed);
  }

  return { data, remainder };
}

function parseEvent(block: string): string | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));

  return data.length === 0 ? undefined : data.join("\n");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}
