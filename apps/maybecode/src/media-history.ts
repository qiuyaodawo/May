import { openAIResponseContent } from "@sortedyuan/providers";
import type { SessionEvent } from "@sortedyuan/may/session";

export function mediaHistory(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map(event => event.type === "assistant.completed"
    ? { ...event, message: { ...event.message, content: [...openAIResponseContent(event.message)] } }
    : event.type === "run.completed"
      ? { ...event, result: { ...event.result, message: { ...event.result.message, content: [...openAIResponseContent(event.result.message)] } } }
    : event);
}
