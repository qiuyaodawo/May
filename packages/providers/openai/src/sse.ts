import { OpenAIResponsesProtocolError } from "./errors.js";

export async function* readOpenAIResponsesSse(
  response: Response,
  signal: AbortSignal,
): AsyncGenerator<string> {
  if (!response.body) {
    throw new OpenAIResponsesProtocolError("OpenAI Responses response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const onAbort = () => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const drained = drain(buffer);
      buffer = drained.remainder;
      for (const data of drained.events) yield data;
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") {
      const data = parseBlock(buffer);
      if (data !== undefined) yield data;
    }
    throwIfAborted(signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function drain(input: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  let remainder = input;
  while (true) {
    const separator = /\r?\n\r?\n/u.exec(remainder);
    if (separator?.index === undefined) break;
    const block = remainder.slice(0, separator.index);
    remainder = remainder.slice(separator.index + separator[0].length);
    const data = parseBlock(block);
    if (data !== undefined) events.push(data);
  }
  return { events, remainder };
}

function parseBlock(block: string): string | undefined {
  const data = block.split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /u, ""));
  return data.length === 0 ? undefined : data.join("\n");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted", "AbortError");
}
