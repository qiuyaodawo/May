import { emitKeypressEvents, type Interface } from "node:readline";
import type { Interface as PromisesInterface } from "node:readline/promises";

/**
 * Isolated compatibility shims for Node.js `node:readline` internals whose TypeScript
 * declarations in `@types/node` omit `escapeCodeTimeout` on `emitKeypressEvents` and
 * the mutable `history` array on `readline.Interface`.
 *
 * Exit condition: remove once `@types/node` exposes typed `emitKeypressEvents` options
 * and `Interface.history`.
 */
export function emitKeypressEventsWithEscapeTimeout(stream: NodeJS.ReadableStream, escapeCodeTimeout: number): void {
  // eslint-disable-next-line may-ban-hacks/no-double-cast -- Isolated Node readline runtime option not yet typed in @types/node.
  emitKeypressEvents(stream, { escapeCodeTimeout } as unknown as Parameters<typeof emitKeypressEvents>[1]);
}

export function readlineHistory(readline: Interface | PromisesInterface): string[] {
  // eslint-disable-next-line may-ban-hacks/no-double-cast -- Isolated Node readline.Interface.history runtime property.
  return (readline as unknown as { readonly history: string[] }).history;
}
